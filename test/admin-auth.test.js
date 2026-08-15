// "Sign in with Vercel" para /admin (#116, PR 5).
//
// Lo que estos tests protegen: sin sesión → redirect a /admin/login; con
// sesión pero el correo fuera de ADMIN_EMAILS → 403 (nunca un login que se
// repite en silencio); sin ADMIN_EMAILS configurada → cerrado para todos,
// incluso para quien de verdad inició sesión con Vercel; el state de CSRF se
// valida de verdad; /api/admin/* queda protegido con el mismo gate; y que la
// cookie de sesión propia no carga nada más que el correo — ni nombre, ni
// foto, ni ningún dato de las personas que reporta la app.
//
// Y, desde el arreglo del reporte de errores: que cada forma de fallar el
// callback se distinga de las demás y llegue dicha con su nombre a la
// pantalla. Un error de Vercel reportado como "la sesión expiró" manda a
// quien depura por el camino equivocado — pasó, y costó horas.
const test = require('node:test');
const assert = require('node:assert');
const env = require('../src/env');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { nullMatcher } = require('../src/faces');
const { fakeVercelOAuth } = require('./helpers');

async function startApp() {
  const app = await createApp(await createSqliteAdapter(':memory:'), nullMatcher);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function cleanupEnv() {
  delete process.env.ADMIN_EMAILS;
  delete process.env.ADMIN_SESSION_SECRET;
}

// Extrae los pares nombre=valor de una respuesta con varios Set-Cookie, y los
// arma de vuelta como header Cookie — no hay cookie jar en fetch de Node.
function cookieHeaderFrom(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  return raw.map((c) => c.split(';')[0]).join('; ');
}

// Recorre el flujo completo: /admin/login/start → captura state+verifier en
// cookies → simula el redirect de vuelta de Vercel a /admin/auth/callback.
// Devuelve la respuesta del callback y el header Cookie final (con o sin la
// sesión, según lo que haya decidido el callback).
async function loginFlow(base, { code = 'fake-code', stateOverride, extraParams = {}, sendCookies = true } = {}) {
  const startRes = await fetch(`${base}/admin/login/start`, { redirect: 'manual' });
  const transientCookies = cookieHeaderFrom(startRes);
  const location = startRes.headers.get('location');
  const state = stateOverride !== undefined ? stateOverride : new URL(location).searchParams.get('state');

  const callbackUrl = new URL(`${base}/admin/auth/callback`);
  if (code !== null) callbackUrl.searchParams.set('code', code);
  if (state !== null) callbackUrl.searchParams.set('state', state);
  for (const [key, value] of Object.entries(extraParams)) callbackUrl.searchParams.set(key, value);

  const callbackRes = await fetch(callbackUrl, {
    redirect: 'manual',
    headers: sendCookies ? { Cookie: transientCookies } : {}
  });
  return { callbackRes, sessionCookies: cookieHeaderFrom(callbackRes) };
}

// Sigue el redirect del callback hasta la pantalla de login, que es donde el
// operador lee de verdad el motivo — el código en la URL no le sirve a nadie
// si la pantalla sigue diciendo otra cosa.
async function loginScreenAfter(base, callbackRes) {
  const res = await fetch(new URL(callbackRes.headers.get('location'), base));
  assert.equal(res.status, 200);
  return res.text();
}

// Deja listo un login que puede completarse, para que lo único que cambie
// entre casos sea lo que devuelve el callback.
async function withLoginReady(t) {
  const oauth = await fakeVercelOAuth();
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    oauth.stop();
    cleanupEnv();
  });
  process.env.ADMIN_SESSION_SECRET = 'secreto-de-prueba-largo-y-aleatorio';
  process.env.ADMIN_EMAILS = 'nic@ejemplo.com';
  oauth.setUserInfo({ email: 'nic@ejemplo.com', email_verified: true });
  return { base };
}

test('sin sesión, GET /admin redirige a /admin/login', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const res = await fetch(`${base}/admin`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /^\/admin\/login/);
});

test('sin sesión, GET /api/admin/lo-que-sea también redirige — mismo gate', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const res = await fetch(`${base}/api/admin/cualquier-cosa`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /^\/admin\/login/);
});

test('sin VERCEL_APP_CLIENT_ID/SECRET/ADMIN_SESSION_SECRET, /admin/login/start responde 503 — no arranca un login roto', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const res = await fetch(`${base}/admin/login/start`, { redirect: 'manual' });
  assert.equal(res.status, 503);
});

test('un correo en ADMIN_EMAILS completa el login y entra a /admin', async (t) => {
  const oauth = await fakeVercelOAuth();
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    oauth.stop();
    cleanupEnv();
  });
  process.env.ADMIN_SESSION_SECRET = 'secreto-de-prueba-largo-y-aleatorio';
  process.env.ADMIN_EMAILS = 'nic@ejemplo.com, alex@ejemplo.com';
  oauth.setUserInfo({ email: 'nic@ejemplo.com', email_verified: true });

  const { callbackRes, sessionCookies } = await loginFlow(base);
  assert.equal(callbackRes.status, 302);
  assert.equal(callbackRes.headers.get('location'), '/admin');

  const adminRes = await fetch(`${base}/admin`, { headers: { Cookie: sessionCookies } });
  assert.equal(adminRes.status, 200);
  const html = await adminRes.text();
  assert.match(html, /nic@ejemplo\.com/);
  assert.match(html, /admin\/stats/);
});

test('un correo FUERA de ADMIN_EMAILS recibe 403 en el callback, sin sesión emitida', async (t) => {
  const oauth = await fakeVercelOAuth();
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    oauth.stop();
    cleanupEnv();
  });
  process.env.ADMIN_SESSION_SECRET = 'secreto-de-prueba-largo-y-aleatorio';
  process.env.ADMIN_EMAILS = 'nic@ejemplo.com';
  oauth.setUserInfo({ email: 'quien-sea@ejemplo.com', email_verified: true });

  const { callbackRes } = await loginFlow(base);
  assert.equal(callbackRes.status, 403);

  // Sin sesión de verdad: /admin sigue mandando al login, no deja pasar nada.
  const adminRes = await fetch(`${base}/admin`, { redirect: 'manual' });
  assert.equal(adminRes.status, 302);
});

test('ADMIN_EMAILS vacía o ausente — cerrado para todos, incluso con un login real y válido en Vercel', async (t) => {
  const oauth = await fakeVercelOAuth();
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    oauth.stop();
    cleanupEnv();
  });
  process.env.ADMIN_SESSION_SECRET = 'secreto-de-prueba-largo-y-aleatorio';
  // ADMIN_EMAILS deliberadamente sin configurar.
  oauth.setUserInfo({ email: 'nic@ejemplo.com', email_verified: true });

  const { callbackRes } = await loginFlow(base);
  assert.equal(callbackRes.status, 403, 'sin allowlist, nadie entra — ni quien de verdad inició sesión');
});

test('un state que no coincide se rechaza — protección CSRF real, no solo declarada', async (t) => {
  const { base } = await withLoginReady(t);

  const { callbackRes } = await loginFlow(base, { stateOverride: 'un-state-inventado' });
  assert.equal(callbackRes.status, 302);
  assert.match(callbackRes.headers.get('location'), /^\/admin\/login\?error=state/);

  const html = await loginScreenAfter(base, callbackRes);
  assert.match(html, /no coincide/i);
});

test('un access_denied de Vercel se reporta como lo que es — nunca como un problema de state', async (t) => {
  const { base } = await withLoginReady(t);

  // Vercel devuelve `error` (+ el `state` original) en vez de `code` cuando la
  // App no le permite entrar a esa cuenta.
  const { callbackRes } = await loginFlow(base, { code: null, extraParams: { error: 'access_denied' } });
  assert.equal(callbackRes.status, 302);
  const location = callbackRes.headers.get('location');
  assert.match(location, /error=oauth/);
  assert.match(location, /oauth_error=access_denied/);
  assert.doesNotMatch(location, /error=state/, 'un rechazo de Vercel no es un fallo de state');

  const html = await loginScreenAfter(base, callbackRes);
  assert.match(html, /Sign-In Access/, 'la pantalla dice qué ajuste de la App hay que revisar');
  assert.match(html, /access_denied/, 'y deja el código de Vercel a la vista');
  assert.doesNotMatch(html, /expiró/, 'nada de mandar a reintentar lo único que no puede funcionar');
});

test('el motivo real sobrevive aunque la cookie del flujo ya no esté — el error de Vercel se lee primero', async (t) => {
  const { base } = await withLoginReady(t);

  const { callbackRes } = await loginFlow(base, {
    code: null,
    sendCookies: false,
    extraParams: { error: 'access_denied' }
  });
  assert.equal(callbackRes.status, 302);
  assert.match(callbackRes.headers.get('location'), /error=oauth&oauth_error=access_denied/);
});

test('un invalid_request llega a la pantalla con la explicación que dio Vercel', async (t) => {
  const { base } = await withLoginReady(t);

  const { callbackRes } = await loginFlow(base, {
    code: null,
    extraParams: { error: 'invalid_request', error_description: "Parameter 'response_type'. Required" }
  });
  const html = await loginScreenAfter(base, callbackRes);
  assert.match(html, /invalid_request/);
  assert.match(html, /Parameter 'response_type'\. Required/, 'el texto del proveedor es lo que apunta al parámetro culpable');
});

test('el error_description de Vercel se muestra escapado — es texto de un tercero', async (t) => {
  const { base } = await withLoginReady(t);

  const { callbackRes } = await loginFlow(base, {
    code: null,
    extraParams: { error: 'invalid_request', error_description: '<script>alert(1)</script>' }
  });
  const html = await loginScreenAfter(base, callbackRes);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('un código de error con forma rara no se propaga a la pantalla', async (t) => {
  const { base } = await withLoginReady(t);

  const { callbackRes } = await loginFlow(base, {
    code: null,
    extraParams: { error: '<img src=x onerror=alert(1)>' }
  });
  const location = callbackRes.headers.get('location');
  assert.match(location, /oauth_error=desconocido/);
  assert.doesNotMatch(location, /onerror/);
});

test('sin code, sin error y con state válido: se dice que faltó el code, no que falló el state', async (t) => {
  const { base } = await withLoginReady(t);

  const { callbackRes } = await loginFlow(base, { code: null });
  assert.equal(callbackRes.status, 302);
  assert.match(callbackRes.headers.get('location'), /^\/admin\/login\?error=no_code$/);
});

test('un callback sin state y sin error se distingue de un state que no coincide', async (t) => {
  const { base } = await withLoginReady(t);

  const { callbackRes } = await loginFlow(base, { stateOverride: null });
  assert.equal(callbackRes.status, 302);
  assert.match(callbackRes.headers.get('location'), /^\/admin\/login\?error=no_state$/);
});

test('sin las cookies del flujo es una sesión de login vencida, no un intento de CSRF', async (t) => {
  const { base } = await withLoginReady(t);

  const { callbackRes } = await loginFlow(base, { sendCookies: false });
  assert.equal(callbackRes.status, 302);
  assert.match(callbackRes.headers.get('location'), /^\/admin\/login\?error=expired$/);

  const html = await loginScreenAfter(base, callbackRes);
  assert.match(html, /10 minutos/, 'la pantalla explica por qué se perdió y qué hacer');
});

test('el state sigue siendo obligatorio para emitir sesión — un error de Vercel no abre ninguna puerta', async (t) => {
  const { base } = await withLoginReady(t);

  const { callbackRes, sessionCookies } = await loginFlow(base, {
    code: 'fake-code',
    stateOverride: 'un-state-inventado',
    extraParams: { error: 'access_denied' }
  });
  assert.equal(callbackRes.status, 302);
  assert.doesNotMatch(sessionCookies, /admin_session=[^;]+/, 'ninguna rama de error emite sesión');

  const adminRes = await fetch(`${base}/admin`, { redirect: 'manual', headers: { Cookie: sessionCookies } });
  assert.equal(adminRes.status, 302, '/admin sigue pidiendo login');
});

test('una clave heredada en la query no imprime nada en la pantalla de login', async (t) => {
  const { base } = await withLoginReady(t);

  const res = await fetch(`${base}/admin/login?error=constructor`);
  const html = await res.text();
  assert.doesNotMatch(html, /⚠️/, 'solo los motivos reales tienen copy');
});

test('POST /admin/logout cierra la sesión — /admin vuelve a pedir login', async (t) => {
  const oauth = await fakeVercelOAuth();
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    oauth.stop();
    cleanupEnv();
  });
  process.env.ADMIN_SESSION_SECRET = 'secreto-de-prueba-largo-y-aleatorio';
  process.env.ADMIN_EMAILS = 'nic@ejemplo.com';
  oauth.setUserInfo({ email: 'nic@ejemplo.com', email_verified: true });

  const { sessionCookies } = await loginFlow(base);
  const okBefore = await fetch(`${base}/admin`, { headers: { Cookie: sessionCookies } });
  assert.equal(okBefore.status, 200);

  const logoutRes = await fetch(`${base}/admin/logout`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: sessionCookies }
  });
  const clearedCookies = cookieHeaderFrom(logoutRes);

  const afterLogout = await fetch(`${base}/admin`, {
    redirect: 'manual',
    headers: { Cookie: clearedCookies }
  });
  assert.equal(afterLogout.status, 302, 'sin sesión tras el logout, /admin vuelve a pedir login');
});

test('la cookie de sesión no carga nada más que el correo y una expiración — ni nombre, ni foto, ni ningún dato de personas', async (t) => {
  const oauth = await fakeVercelOAuth();
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    oauth.stop();
    cleanupEnv();
  });
  process.env.ADMIN_SESSION_SECRET = 'secreto-de-prueba-largo-y-aleatorio';
  process.env.ADMIN_EMAILS = 'nic@ejemplo.com';
  // email_verified es lo único adicional que devuelve el userinfo de mentiras
  // — name/picture ni se piden (scope 'openid email' nada más), así que no
  // pueden aparecer en la cookie aunque el fake los mandara.
  oauth.setUserInfo({ email: 'nic@ejemplo.com', email_verified: true, name: 'Nic Contreras', picture: 'https://x/y.png' });

  const { sessionCookies } = await loginFlow(base);
  const match = sessionCookies.match(/admin_session=([^;]+)/);
  assert.ok(match, 'debía quedar seteada la cookie admin_session');
  const [payload] = decodeURIComponent(match[1]).split('.');
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(data).sort(), ['email', 'exp']);
  assert.equal(data.email, 'nic@ejemplo.com');
});
