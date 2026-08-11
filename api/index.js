// Vercel serverless entry point: the whole Express app runs as one function.
// Static assets in /public are served by Vercel's CDN before reaching here.
const { createApp } = require('../src/server');

let appPromise;

// createApp() opens the database before it registers a single route, so a boot
// failure takes down every path, /health included. Caching the REJECTED promise
// would make that failure permanent for this instance: it would keep answering
// 500 to everything until Vercel recycles it, long after the database is back.
// So the failure is cleared and the next request builds the app again. Requests
// that arrive during a cold start still share one build — the clearing happens
// on rejection, not on entry.
function getApp() {
  if (!appPromise) {
    appPromise = createApp().catch((err) => {
      appPromise = undefined;
      throw err;
    });
  }
  return appPromise;
}

module.exports = async (req, res) => {
  let app;
  try {
    app = await getApp();
  } catch (err) {
    console.error('[boot] la app no pudo arrancar', err);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('El servicio no está disponible en este momento. Vuelve a intentarlo en unos segundos.');
  }
  return app(req, res);
};
