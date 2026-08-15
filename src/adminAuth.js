// "Sign in with Vercel" para /admin (#116, PR 5) — decisión aprobada por el
// operador: el auth se queda en Vercel porque Nic y Alex ya tienen silla en
// el team. Es un IdP OAuth 2.0 / OIDC genérico y estándar — nada atado a
// Next.js pese a que la documentación de Vercel solo trae ejemplos en ese
// framework. Referencia: https://vercel.com/docs/sign-in-with-vercel
//
// Endpoints (https://vercel.com/docs/sign-in-with-vercel/authorization-server-api):
//   Authorization: https://vercel.com/oauth/authorize        (redirect del navegador)
//   Token:         POST https://api.vercel.com/login/oauth/token
//   User info:     GET  https://api.vercel.com/login/oauth/userinfo
//   Revoke:        POST https://api.vercel.com/login/oauth/token/revoke
//
// Diseño: el flujo OAuth con Vercel se usa SOLO en el login, para probar
// "esta persona es dueña de este correo en Vercel". Después de eso no hace
// falta seguir hablando con Vercel — se emite una cookie de sesión PROPIA,
// firmada con HMAC, igual de stateless que el resto de los tokens de este
// repo (verify_token de suscripciones, unsubscribe token): nada que guardar
// en la base, nada que limpiar. El access/refresh token de Vercel no se
// retiene entre requests.
//
// PKCE (code_challenge/code_verifier) protege la intercepción del código; el
// parámetro `state` protege CSRF entre el redirect de ida y el de vuelta.
// `nonce` no se usa: solo tendría sentido si este código consumiera el
// id_token, y no lo hace — el correo verificado sale de una llamada aparte,
// autenticada, al User Info Endpoint, sobre el MISMO access_token que ya
// quedó atado a este code_verifier en el intercambio. Añadir nonce ahí no
// suma protección real, y esta app ya tiene bastante superficie sin
// necesidad.
const crypto = require('crypto');
const env = require('./env');

// Funciones, no const — igual que clientId()/clientSecret() más abajo: leídas
// en vivo de process.env para que una prueba pueda apuntar a un servidor de
// mentiras sin reiniciar el proceso. Mismo patrón que SENDGRID_API_BASE /
// WHATSAPP_API_BASE / GITHUB_API_BASE en este repo.
function authorizeUrl() {
  return process.env.VERCEL_OAUTH_AUTHORIZE_URL || 'https://vercel.com/oauth/authorize';
}
function apiBase() {
  return process.env.VERCEL_OAUTH_API_BASE || 'https://api.vercel.com';
}

const OAUTH_STATE_COOKIE = 'admin_oauth_state';
const OAUTH_VERIFIER_COOKIE = 'admin_oauth_verifier';
const SESSION_COOKIE = 'admin_session';

const OAUTH_TRANSIENT_MAX_AGE = 10 * 60; // 10 minutos — solo dura el ida-y-vuelta del redirect.
const SESSION_MAX_AGE = 12 * 60 * 60; // 12 horas — sesión propia, no atada a la duración del access_token de Vercel.

function callbackUrl() {
  return `${env.BASE_URL}/admin/auth/callback`;
}

// Live desde process.env, con env.js como respaldo — mismo patrón que
// AVISO_EMAIL/SENDGRID_API_KEY en notify.js y CRON_SECRET en api.js: así una
// prueba puede fijar o borrar estas variables sin reiniciar el proceso, y un
// valor que cambie en caliente (poco probable acá, pero es el mismo
// contrato) se respeta igual.
function clientId() {
  return (process.env.VERCEL_APP_CLIENT_ID || env.VERCEL_APP_CLIENT_ID || '').trim();
}
function clientSecret() {
  return (process.env.VERCEL_APP_CLIENT_SECRET || env.VERCEL_APP_CLIENT_SECRET || '').trim();
}
function sessionSecret() {
  return (process.env.ADMIN_SESSION_SECRET || env.ADMIN_SESSION_SECRET || '').trim();
}

// -------------------------------------------------------------- PKCE + cookies

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function codeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// Cookies propias, con el mismo estilo crudo que ya usa este repo (ver
// remember() en src/routes/web.js) — nunca se agregó cookie-parser, así que
// acá tampoco. httpOnly + Secure (fuera de local) + SameSite=Lax: a
// diferencia de la cookie de "recordar contacto" (nunca sensible), esta SÍ
// decide quién entra a /admin.
function setCookie(res, name, value, maxAgeSeconds) {
  const secure = env.BASE_URL.startsWith('https://') ? '; Secure' : '';
  res.append(
    'Set-Cookie',
    `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure}`
  );
}

function clearCookie(res, name) {
  res.append('Set-Cookie', `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  const hit = raw
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(name + '='));
  if (!hit) return '';
  try {
    return decodeURIComponent(hit.slice(name.length + 1));
  } catch {
    return '';
  }
}

// -------------------------------------------------------------- sesión firmada

// Compara en tiempo constante — nada de === en una firma. Mismo cuidado que
// ya usa el repo con las credenciales de relevo de WhatsApp
// (WHATSAPP_RELAY_SECRET, ver src/routes/webhooks.js).
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function sign(payload) {
  return crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
}

// `email` + una expiración propia (12 h) — nada más. Ni nombre, ni foto, ni
// el sub de Vercel: lo único que decide algo en este sistema es si ese
// correo está en ADMIN_EMAILS, y para eso alcanza con el correo.
function issueSessionCookie(res, email) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE;
  const payload = Buffer.from(JSON.stringify({ email, exp })).toString('base64url');
  const sig = sign(payload);
  setCookie(res, SESSION_COOKIE, `${payload}.${sig}`, SESSION_MAX_AGE);
}

// Devuelve el email de la sesión válida, o null. Nunca lanza: una cookie
// corrupta o vencida es lo mismo que no tener sesión, no un 500.
function readSession(req) {
  if (!sessionSecret()) return null;
  const raw = readCookie(req, SESSION_COOKIE);
  if (!raw || !raw.includes('.')) return null;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!data.email || typeof data.exp !== 'number' || data.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return data.email;
}

function clearSessionCookie(res) {
  clearCookie(res, SESSION_COOKIE);
}

// -------------------------------------------------------------- allowlist

// Vacía o ausente = cerrado para todos — nunca abierto. La misma regla que ya
// rige requireKeyOrCron en src/routes/api.js: sin configurar no hay puerta
// que abrir por accidente.
function adminEmails() {
  return (process.env.ADMIN_EMAILS || env.ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function isAllowedEmail(email) {
  const allowed = adminEmails();
  if (!allowed.length || !email) return false;
  return allowed.includes(String(email).trim().toLowerCase());
}

// -------------------------------------------------------------- flujo OAuth

function oauthConfigured() {
  return !!(clientId() && clientSecret() && sessionSecret());
}

// GET /admin/login — arranca el flujo. Guarda state + code_verifier en
// cookies httpOnly de corta vida y redirige a Vercel.
function beginLogin(req, res) {
  if (!oauthConfigured()) {
    return res
      .status(503)
      .send('Login de administración no configurado. Faltan VERCEL_APP_CLIENT_ID, VERCEL_APP_CLIENT_SECRET o ADMIN_SESSION_SECRET.');
  }
  const state = randomToken(24);
  const verifier = randomToken(32);
  setCookie(res, OAUTH_STATE_COOKIE, state, OAUTH_TRANSIENT_MAX_AGE);
  setCookie(res, OAUTH_VERIFIER_COOKIE, verifier, OAUTH_TRANSIENT_MAX_AGE);

  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: callbackUrl(),
    state,
    code_challenge: codeChallenge(verifier),
    code_challenge_method: 'S256',
    response_type: 'code',
    // Solo lo que se usa: openid es obligatorio, email es lo único que
    // decide algo acá. Ni profile ni offline_access — no hace falta el
    // nombre ni la foto, y no se retiene ningún token entre requests.
    scope: 'openid email'
  });
  res.redirect(`${authorizeUrl()}?${params.toString()}`);
}

async function exchangeCodeForToken(code, verifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId(),
    client_secret: clientSecret(),
    code,
    code_verifier: verifier,
    redirect_uri: callbackUrl()
  });
  const res = await fetch(`${apiBase()}/login/oauth/token`, { method: 'POST', body });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`token endpoint respondió ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function fetchUserInfo(accessToken) {
  const res = await fetch(`${apiBase()}/login/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`userinfo respondió ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// Best effort — un fallo acá no debe impedir cerrar la sesión local. El
// access_token de todos modos expira solo.
async function revokeToken(accessToken) {
  if (!accessToken) return;
  try {
    const credentials = Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64');
    await fetch(`${apiBase()}/login/oauth/token/revoke`, {
      method: 'POST',
      headers: { Authorization: `Basic ${credentials}` },
      body: new URLSearchParams({ token: accessToken })
    });
  } catch (e) {
    console.error('[admin-auth] no se pudo revocar el token en Vercel (no bloqueante):', e.message);
  }
}

// El código de error de OAuth es un token corto (`access_denied`,
// `invalid_request`, …). Todo lo que no tenga esa forma no se propaga: no es
// algo que Vercel emita y no vale la pena arrastrarlo a la URL de la pantalla
// de login.
const OAUTH_ERROR_CODE_RE = /^[a-zA-Z0-9_.:-]{1,64}$/;
// `error_description` es texto libre de un tercero. Se muestra porque ayuda a
// diagnosticar (Vercel dice ahí QUÉ parámetro no le gustó), pero acotado.
const OAUTH_DESCRIPTION_MAX = 300;

// El mismo texto tiene dos destinos con necesidades opuestas, así que se
// prepara dos veces:
//
//   - La PANTALLA lo quiere corto (OAUTH_DESCRIPTION_MAX) para no volverse
//     ilegible con un mensaje largo.
//   - El LOG lo quiere completo: truncarlo antes de registrarlo borra
//     justamente el detalle por el que existe este bloque.
//
// Y en los dos casos hay que neutralizar saltos de línea y control: el valor
// viene de la query, así que un `%0A` deja escribir una línea entera de log
// que parece emitida por el servidor. Se colapsa a espacios antes de escribir.
function oneLine(text) {
  return text.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim();
}

function redirectToLogin(res, params) {
  return res.redirect(`/admin/login?${new URLSearchParams(params).toString()}`);
}

// GET /admin/auth/callback — valida state, intercambia el code, pide el
// email verificado y decide: allowlist → sesión propia; lo que sea que
// falle → a /admin/login con el motivo, nunca una sesión a medias.
//
// Cada motivo sale con su propio código porque son diagnósticos distintos y
// llevan a arreglos distintos. Antes los cinco caían en `error=state`, y eso
// costó horas de depuración: un `access_denied` de Vercel —la App configurada
// para admitir solo miembros del team dueño— se leía en pantalla como "la
// sesión de login expiró", que manda a reintentar justo lo único que no puede
// funcionar.
async function completeLogin(req, res) {
  clearCookie(res, OAUTH_STATE_COOKIE);
  clearCookie(res, OAUTH_VERIFIER_COOKIE);

  if (!oauthConfigured()) {
    return res.status(503).send('Login de administración no configurado.');
  }
  const { code, state, error: providerError, error_description: providerDescription } = req.query;
  const storedState = readCookie(req, OAUTH_STATE_COOKIE);
  const verifier = readCookie(req, OAUTH_VERIFIER_COOKIE);
  const stateMatches = !!(state && storedState && safeEqual(state, storedState));

  // 1) Vercel contestó con un error explícito. Contrato OAuth 2.0 estándar:
  // vuelve `error` (+ `error_description` opcional) en vez de `code`.
  // Referencia: https://vercel.com/docs/sign-in-with-vercel/troubleshooting
  //
  // Se atiende ANTES de validar el `state`, y no es un descuido: `state`
  // protege contra que un tercero inyecte SU código de autorización en la
  // sesión de otro, y esta rama no intercambia ningún código ni emite ninguna
  // sesión — no hay nada que ganar inyectándola. Validarlo primero solo
  // serviría para enterrar el motivo real cuando la cookie de 10 minutos ya
  // venció, que es exactamente el error que este código venía cometiendo. El
  // resultado del cotejo igual queda en el log.
  if (providerError) {
    const oauthError = OAUTH_ERROR_CODE_RE.test(String(providerError)) ? String(providerError) : 'desconocido';
    // Completa para el log (es el detalle por el que existe este bloque) y
    // acotada para la pantalla. Las dos pasan por oneLine: el valor viene de
    // la query y un salto de línea dejaría escribir una línea de log falsa.
    const descriptionForLog = oneLine(String(providerDescription || ''));
    const description = descriptionForLog.slice(0, OAUTH_DESCRIPTION_MAX);
    console.warn(
      `[admin-auth] Vercel rechazó la autorización: error=${oauthError} error_description=${descriptionForLog || '(ninguna)'} ` +
        `— state ${!state ? 'ausente' : stateMatches ? 'coincide' : 'NO coincide'}`
    );
    return redirectToLogin(res, {
      error: 'oauth',
      oauth_error: oauthError,
      ...(description ? { oauth_description: description } : {})
    });
  }

  // 2) Ni error ni state: la respuesta no es la de un flujo que arrancó acá.
  if (!state) {
    console.warn('[admin-auth] callback sin `state` y sin `error` — la respuesta no corresponde a un login iniciado acá');
    return redirectToLogin(res, { error: 'no_state' });
  }

  // 3) Vino el state pero no hay con qué compararlo: la cookie de ida se
  // venció (10 min) o el navegador no la mandó. No es CSRF, es una sesión de
  // login perdida, y se arregla volviendo a empezar.
  if (!storedState || !verifier) {
    console.warn(
      `[admin-auth] callback sin las cookies del flujo (state guardado: ${storedState ? 'sí' : 'no'}, ` +
        `verifier: ${verifier ? 'sí' : 'no'}) — sesión de login vencida o cookie perdida`
    );
    return redirectToLogin(res, { error: 'expired' });
  }

  // 4) Están las dos y no coinciden. Acá sí: esto es lo que el `state`
  // existe para frenar.
  if (!stateMatches) {
    console.warn('[admin-auth] callback con `state` que NO coincide con el de esta sesión — posible CSRF, rechazado');
    return redirectToLogin(res, { error: 'state' });
  }

  // 5) State válido pero Vercel no mandó código ni dijo por qué.
  if (!code) {
    console.warn('[admin-auth] callback con `state` válido pero sin `code` y sin `error` — respuesta incompleta de Vercel');
    return redirectToLogin(res, { error: 'no_code' });
  }

  let tokenData;
  try {
    tokenData = await exchangeCodeForToken(String(code), verifier);
  } catch (e) {
    console.error('[admin-auth] intercambio de código falló:', e.message);
    return res.redirect('/admin/login?error=token');
  }

  let userInfo;
  try {
    userInfo = await fetchUserInfo(tokenData.access_token);
  } catch (e) {
    console.error('[admin-auth] userinfo falló:', e.message);
    return res.redirect('/admin/login?error=userinfo');
  }

  // El token ya cumplió su propósito (probar el correo); no se retiene.
  await revokeToken(tokenData.access_token);

  if (!userInfo.email || !userInfo.email_verified) {
    console.warn('[admin-auth] login sin correo verificado — rechazado');
    return res.redirect('/admin/login?error=unverified');
  }
  if (!isAllowedEmail(userInfo.email)) {
    console.warn(`[admin-auth] login de ${userInfo.email} — no está en ADMIN_EMAILS`);
    return res.status(403).send('Tu cuenta de Vercel no está autorizada para /admin.');
  }

  issueSessionCookie(res, userInfo.email);
  res.redirect('/admin');
}

function logout(req, res) {
  clearSessionCookie(res);
  res.redirect('/admin/login');
}

// Middleware: sin sesión válida → redirect a /admin/login; con sesión pero
// fuera de la allowlist → 403 (nunca silencioso: la sesión existía, el
// problema es la autorización, y eso hay que decirlo, no esconderlo detrás
// de un login que se repite para siempre).
function requireAdminSession(req, res, next) {
  const email = readSession(req);
  if (!email) {
    return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  if (!isAllowedEmail(email)) {
    return res.status(403).send('Tu sesión ya no está autorizada para /admin (revisa ADMIN_EMAILS).');
  }
  req.adminEmail = email;
  next();
}

// ---------------------------------------------------- ventana pública temporal
//
// #116, PR 6 — decisión del operador: el panel de estadísticas (SOLO cifras
// agregadas, nunca el drill-down por ID) puede verse en producción sin sesión
// mientras el auth de verdad termina de configurarse. PUBLIC_STATS='1' es el
// ÚNICO valor que lo abre — cualquier otro valor, incluida su ausencia, lo
// deja detrás del mismo gate que el resto de /admin. Cerrarlo después es
// borrar la variable, no un PR.
function publicStatsOpen() {
  return (process.env.PUBLIC_STATS || '').trim() === '1';
}

// Middleware de /admin/stats: si la ventana pública está abierta, pasa
// directo (sin sesión); si no, exige sesión como cualquier otra ruta de
// /admin. El drill-down (si algún día existe) NUNCA usa este middleware —
// nace directo con requireAdminSession, sin ninguna puerta de "mientras
// tanto".
function statsGate(req, res, next) {
  if (publicStatsOpen()) return next();
  return requireAdminSession(req, res, next);
}

module.exports = {
  beginLogin,
  completeLogin,
  logout,
  requireAdminSession,
  readSession,
  isAllowedEmail,
  adminEmails,
  oauthConfigured,
  publicStatsOpen,
  statsGate,
  SESSION_COOKIE
};
