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
const { gatherReportData, gatherDailySeries } = require('../report');
const { buildStatsPageHtml } = require('../adminStats');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function adminRoutes(store, matcher) {
  const router = express.Router();

  router.get('/login', (req, res) => {
    const error = req.query.error;
    const ERROR_COPY = {
      state: 'La sesión de login expiró o no coincide. Intenta de nuevo.',
      token: 'Vercel no pudo confirmar el código de acceso. Intenta de nuevo.',
      userinfo: 'No se pudo leer tu cuenta de Vercel. Intenta de nuevo.',
      unverified: 'Tu correo de Vercel no está verificado — Vercel exige un correo verificado para entrar acá.'
    };
    // Sin estilos propios a propósito: es el gate, no el panel — el PR 6 es
    // quien merece inversión de diseño.
    const body = `
      <h1>Acceso de administración</h1>
      ${error && ERROR_COPY[error] ? `<p>⚠️ ${esc(ERROR_COPY[error])}</p>` : ''}
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
  router.get(
    '/stats',
    statsGate,
    wrap(async (req, res) => {
      const [data, daily] = await Promise.all([gatherReportData(store, matcher), gatherDailySeries(store)]);
      // Cabecera además del <meta robots> del layout — dos capas, porque un
      // crawler puede no ejecutar/leer el <head> completo.
      res.set('X-Robots-Tag', 'noindex, nofollow');
      res.send(buildStatsPageHtml(data, daily, { isPublic: publicStatsOpen() }));
    })
  );

  return router;
}

// Router aparte para /api/admin/* — hoy sin ningún endpoint propio (el panel
// real, PR 6, es quien los va a necesitar), pero con el MISMO gate ya
// montado y probado: cualquier ruta que se agregue ahí después nace
// protegida, sin tener que acordarse de aplicar el middleware.
function adminApiRoutes() {
  const router = express.Router();
  router.use(requireAdminSession);
  return router;
}

module.exports = { adminRoutes, adminApiRoutes, adminEmails };
