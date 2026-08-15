// Rutas de /admin (#116, PR 5 + PR 6) — el login con Vercel, el gate, y el
// panel de estadísticas. El drill-down por ID (resolver nombres/contactos en
// vivo) NO existe todavía — cuando exista, nace en /api/admin/* con
// requireAdminSession, nunca en esta superficie.
const express = require('express');
const { layout, esc } = require('../html');
const {
  beginLogin,
  completeLogin,
  logout,
  requireAdminSession,
  adminEmails,
  statsGate,
  publicStatsOpen
} = require('../adminAuth');
const { gatherCheapReportData, gatherFunnelStats, gatherDailySeries, gatherPanelExtras } = require('../report');
const { buildStatsPageHtml, buildFunnelFragmentHtml } = require('../adminStats');
const { forgetPersonFaces } = require('../facematch');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Copy de la pantalla de login: un mensaje por motivo, y cada uno dice qué
// pasó y qué hacer al respecto. Los motivos los separa completeLogin (ver
// src/adminAuth.js) — antes casi todos llegaban acá como `state`, y un
// "la sesión expiró" ante un rechazo de Vercel deja a la persona reintentando
// justo lo único que no puede funcionar.
const ERROR_COPY = {
  oauth: 'Vercel rechazó el inicio de sesión.',
  no_state: 'La respuesta de Vercel no corresponde a un login iniciado desde acá. Empieza de nuevo con el enlace de abajo.',
  expired:
    'La sesión de login expiró o el navegador no conservó su cookie (dura 10 minutos). Empieza de nuevo con el enlace de abajo.',
  state:
    'El parámetro de seguridad del login no coincide con el de esta sesión. Si llegaste acá por un enlace que te mandaron, no lo uses: empieza el login desde esta pantalla.',
  no_code: 'Vercel no devolvió el código de autorización y tampoco dijo por qué. Intenta de nuevo.',
  token: 'Vercel no pudo confirmar el código de acceso. Intenta de nuevo.',
  userinfo: 'No se pudo leer tu cuenta de Vercel. Intenta de nuevo.',
  unverified: 'Tu correo de Vercel no está verificado — Vercel exige un correo verificado para entrar acá.'
};

// Qué significa cada código del servidor de autorización de Vercel, en
// términos de qué hay que tocar para arreglarlo.
// https://vercel.com/docs/sign-in-with-vercel/troubleshooting
const OAUTH_ERROR_COPY = {
  access_denied:
    'La App de Vercel no le está dando acceso a esa cuenta. Si está configurada para admitir solo a miembros del team dueño, hay que entrar con una cuenta de ese team, o cambiarle el ajuste «Sign-In Access» a «Anyone with a Vercel account».',
  invalid_request: 'Vercel rechazó la petición de autorización porque un parámetro venía mal — el detalle de abajo dice cuál.',
  server_error: 'Vercel tuvo un error interno procesando la autorización. Intenta de nuevo en un momento.',
  temporarily_unavailable:
    'El servicio de autorización de Vercel no está disponible en este momento. Intenta de nuevo en un momento.'
};

// hasOwnProperty y no `table[key]` a secas: la clave viene de la query, y
// `?error=constructor` no debería imprimir nada.
function copyFor(table, key) {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : '';
}

// Todo lo que sale acá viene de la query, así que TODO pasa por esc(). El
// `error_description` en particular es texto de un tercero (Vercel), y
// cualquiera puede armar la URL a mano con lo que se le ocurra.
function loginErrorHtml(query) {
  const main = copyFor(ERROR_COPY, query.error);
  if (!main) return '';
  const lines = [main];

  if (query.error === 'oauth') {
    const oauthError = typeof query.oauth_error === 'string' ? query.oauth_error.trim() : '';
    const specific = copyFor(OAUTH_ERROR_COPY, oauthError);
    if (specific) lines.push(specific);
    if (oauthError) lines.push(`Código que devolvió Vercel: ${oauthError}`);
    const description = typeof query.oauth_description === 'string' ? query.oauth_description.trim() : '';
    if (description) lines.push(`Vercel dice: «${description}»`);
  }

  return `<p>⚠️ ${lines.map(esc).join('<br>')}</p>`;
}

function adminRoutes(store, matcher) {
  const router = express.Router();

  router.get('/login', (req, res) => {
    // Sin estilos propios a propósito: es el gate, no el panel — el PR 6 es
    // quien merece inversión de diseño.
    const body = `
      <h1>Acceso de administración</h1>
      ${loginErrorHtml(req.query)}
      <p><a href="/admin/login/start">Iniciar sesión con Vercel</a></p>
    `;
    res.send(layout('Acceso de administración', body, { path: '/admin/login' }));
  });

  // Separado de GET /login (la pantalla) para que un <a href> simple alcance
  // — sin esto, la pantalla de error no podría linkear "reintentar" sin
  // volver a arrancar el flujo en el mismo request que la muestra.
  router.get('/login/start', beginLogin);

  router.get('/auth/callback', wrap(completeLogin));

  router.post('/logout', logout);

  router.get('/', requireAdminSession, (req, res) => {
    const body = `
      <h1>Panel de administración</h1>
      <p>Sesión: <strong>${esc(req.adminEmail)}</strong></p>
      <p>📊 <a href="/admin/stats">Estadísticas</a> — coincidencias, envíos y la base en general.</p>
      <p>El drill-down por ID (nombres y contactos en vivo) todavía no existe.</p>
      <form method="post" action="/admin/logout"><button type="submit">Cerrar sesión</button></form>
    `;
    res.send(layout('Panel de administración', body, { path: '/admin' }));
  });

  // #116, PR 6 — SOLO cifras agregadas, la misma clase de dato que ya es
  // pública en GET /api/diag. statsGate decide si hace falta sesión: abierta
  // solo si PUBLIC_STATS='1' (ventana temporal mientras se termina de
  // configurar el auth de verdad), cerrada por omisión como todo lo demás.
  //
  // Hotfix post-#127: esta ruta SOLO llama a gatherCheapReportData (bitácora
  // + conteos + serie, todo consultas a la base con índice) — nunca
  // computeMatchStats. El recompute contra Rekognition medía 28,7s en prod
  // con ~110 fotos, corriendo ADENTRO de este mismo request: eso era el 504
  // (maxDuration estaba en 30s). Se movió a su propio endpoint, GET
  // /admin/stats/funnel, que la página pide aparte después de renderizar.
  router.get(
    '/stats',
    statsGate,
    wrap(async (req, res) => {
      // #132: las tres cifras nuevas (duplicados, personas fotografiadas por
      // rescatistas, tramos de confianza) son tan baratas como
      // gatherCheapReportData — nada de esto toca Rekognition, así que se
      // piden en paralelo con el resto del camino síncrono, no aparte como
      // el embudo.
      const [data, daily, extras] = await Promise.all([
        gatherCheapReportData(store, matcher),
        gatherDailySeries(store),
        gatherPanelExtras(store)
      ]);
      // Cabecera además del <meta robots> del layout — dos capas, porque un
      // crawler puede no ejecutar/leer el <head> completo.
      res.set('X-Robots-Tag', 'noindex, nofollow');
      res.send(buildStatsPageHtml({ ...data, extras }, daily, { isPublic: publicStatsOpen() }));
    })
  );

  // La sección cara, diferida (hotfix post-#127). Mismo statsGate que
  // /admin/stats — misma clase de dato, mismo criterio de público/gateado.
  // Nunca calla un fallo: si computeMatchStats revienta por algo distinto a
  // los fallos por-foto que ya atrapa internamente (p.ej. la base no
  // responde), acá se declara en vez de dejar la sección en blanco o, peor,
  // mostrar un cero que parezca un dato real.
  router.get(
    '/stats/funnel',
    statsGate,
    wrap(async (req, res) => {
      res.set('X-Robots-Tag', 'noindex, nofollow');
      try {
        const { stats, durationMs } = await gatherFunnelStats(store, matcher);
        console.log(`[admin-stats:funnel] recompute ${(durationMs / 1000).toFixed(1)}s`);
        res.send(buildFunnelFragmentHtml(stats, matcher.status));
      } catch (e) {
        console.error('[admin-stats:funnel] recompute falló:', e.message);
        res
          .status(502)
          .send(
            '<p style="padding:10px 12px;background:#fdecea;border:1px solid #f5b5ae;border-radius:4px;">⚠️ No se pudo calcular el embudo de coincidencias en este momento. Intenta recargar en un minuto.</p>'
          );
      }
    })
  );

  return router;
}

// Router aparte para /api/admin/* — el gate ya montado y probado: cualquier
// ruta que se agregue acá nace protegida, sin tener que acordarse de aplicar
// el middleware.
function adminApiRoutes(store, matcher) {
  const router = express.Router();
  router.use(requireAdminSession);

  // POST /api/admin/people/:id/forget-face — retira la firma facial de una
  // persona SIN borrar su ficha (#161). A diferencia de DELETE
  // /api/people/:id, la persona se queda, y con ella la línea de tiempo de su
  // reporte — pensado para cuando una familia avisa que ya la encontró y pide
  // que deje de ser encontrable por reconocimiento facial.
  router.post(
    '/people/:id/forget-face',
    wrap(async (req, res) => {
      const person = await store.getPerson(req.params.id);
      if (!person) return res.status(404).json({ error: 'Persona no encontrada' });

      // Los ids se leen ANTES de nada — mismo motivo que en DELETE
      // /api/people/:id: es la única fuente de qué hay que retirar.
      const faceIds = await store.faceIdsForPerson(person.id);
      const faces = await forgetPersonFaces(matcher, faceIds, person.id);

      // A propósito NO se pone face_id en NULL: si se pusiera, el próximo
      // backfillUnindexedPhotos (que solo mira face_id IS NULL) volvería a
      // indexar la misma foto y deshacía en silencio lo que se le prometió a
      // la familia. La fila se queda con un face_id que ya no existe en la
      // colección — inerte, y por eso no vuelve a coincidir con nadie.
      //
      // La constancia lleva el resultado REAL, no la intención: forgetPersonFaces
      // es best effort y no lanza si Rekognition falla, así que sin
      // unconfirmed_count la fila diría "se retiró la firma" aunque hubiera
      // quedado indexada — inservible para auditar si de verdad se cumplió lo
      // prometido a la familia.
      const action = await store.recordPrivacyAction({
        personId: person.id,
        action: 'forget_face',
        actor: req.adminEmail,
        unconfirmedCount: faces.unconfirmed.length
      });

      res.json({
        ok: true,
        person: { id: person.id, full_name: person.full_name },
        faces,
        action: { id: action.id, created_at: action.created_at, unconfirmed_count: action.unconfirmed_count }
      });
    })
  );

  return router;
}

module.exports = { adminRoutes, adminApiRoutes, adminEmails };
