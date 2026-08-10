const path = require('path');
const express = require('express');
const env = require('./env');
const { createAdapter } = require('./store');
const { createStore } = require('./people');
const { createMatcher } = require('./faces');
const { webRoutes } = require('./routes/web');
const { apiRoutes } = require('./routes/api');
const { webhookRoutes } = require('./routes/webhooks');

async function createApp(adapter, matcher) {
  const store = createStore(adapter || (await createAdapter()));
  const faceMatcher = matcher || (await createMatcher());
  const app = express();
  app.disable('x-powered-by');

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use('/api', apiRoutes(store, faceMatcher));
  app.use('/webhooks', express.json(), webhookRoutes(store, faceMatcher));
  app.use('/', webRoutes(store, faceMatcher));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.name === 'MulterError') {
      const msg =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'La foto es demasiado grande (máx. 4 MB). Intenta con una foto más pequeña.'
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
      console.log(`Aquí escuchando en ${env.BASE_URL} (puerto ${env.PORT})`);
    });
  });
}

module.exports = { createApp };
