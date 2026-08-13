// Rutas de /admin (#116, PR 5) — el login con Vercel, el gate, y un stub
// mínimo detrás de él para probar el flujo completo en preview. El panel de
// verdad es el PR 6; esto es a propósito un "en construcción" honesto, no
// una promesa vacía.
const express = require('express');
const { layout, esc } = require('../html');
const { beginLogin, completeLogin, logout, requireAdminSession, adminEmails } = require('../adminAuth');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function adminRoutes() {
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
      <p>🚧 Panel en construcción — llega en el PR 6 de la secuencia de <a href="https://github.com/encontradosco/encontrados/issues/116">#116</a>.
      Esta página confirma que el login con Vercel y el gate de <code>/admin</code> funcionan de punta a punta.</p>
      <form method="post" action="/admin/logout"><button type="submit">Cerrar sesión</button></form>
    `;
    res.send(layout('Panel de administración', body, { path: '/admin' }));
  });

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
