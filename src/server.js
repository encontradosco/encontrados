const path = require('path');
const express = require('express');
const env = require('./env');
const { createAdapter } = require('./store');
const { createStore } = require('./people');
const { createLazyMatcher } = require('./faces');
const { webRoutes } = require('./routes/web');
const { apiRoutes } = require('./routes/api');
const { webhookRoutes } = require('./routes/webhooks');

async function createApp(adapter, matcher) {
  const store = createStore(adapter || (await createAdapter()));
  const faceMatcher = matcher || createLazyMatcher();
  if (!matcher) {
    // Warm it up so boot logs show Rekognition status immediately.
    faceMatcher.ensureReady().catch((e) => console.error('[faces] warmup', e));
  }
  const app = express();
  app.disable('x-powered-by');

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use('/api', apiRoutes(store, faceMatcher));
  app.use('/webhooks', express.json(), webhookRoutes(store, faceMatcher));
  app.use('/', webRoutes(store, faceMatcher));

  app.use((req, res) => {
    // Log everything needed to diagnose a 404 from the Vercel logs alone.
    console.warn(
      `[404] ${req.method} ${req.originalUrl} host=${req.get('host')} referer=${req.get('referer') || '-'} ct=${req.get('content-type') || '-'}`
    );
    const where = `${req.method} ${req.originalUrl}`.replace(/[<>&"]/g, '');
    res
      .status(404)
      .send(
        `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>No encontrado — encontrados.co</title><body style="font-family:system-ui;max-width:640px;margin:2rem auto;padding:0 1rem"><h1>Página no encontrada</h1><p>Vuelve al <a href="/">inicio</a> para reportar o buscar a alguien.</p><p style="color:#666;font-size:.85rem">Ruta solicitada: <code>${where}</code></p></body></html>`
      );
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.name === 'MulterError') {
      const msg =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'La foto es demasiado grande (máx. 12 MB). Intenta con una foto más pequeña.'
          : 'Demasiados archivos o carga inválida. Sube máximo 3 fotos.';
      if (req.path.startsWith('/api')) return res.status(400).json({ error: msg });
      return res.status(400).send(msg);
    }
    console.error('[error]', err);
    if (req.path.startsWith('/api')) return res.status(500).json({ error: 'Error interno' });
    res.status(500).send('Error interno del servidor');
  });

  app.locals.store = store;
  app.locals.matcher = faceMatcher;
  return app;
}

if (require.main === module) {
  createApp().then((app) => {
    app.listen(env.PORT, () => {
      console.log(`encontrados.co escuchando en ${env.BASE_URL} (puerto ${env.PORT})`);
    });
  });
}

module.exports = { createApp };
