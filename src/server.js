const path = require('path');
const express = require('express');
const env = require('./env');
const { createAdapter } = require('./store');
const { createStore } = require('./people');
const { webRoutes } = require('./routes/web');
const { apiRoutes } = require('./routes/api');
const { webhookRoutes } = require('./routes/webhooks');

async function createApp(adapter) {
  const store = createStore(adapter || (await createAdapter()));
  const app = express();
  app.disable('x-powered-by');

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use('/api', apiRoutes(store));
  app.use('/webhooks', express.json(), webhookRoutes(store));
  app.use('/', webRoutes(store));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[error]', err);
    if (req.path.startsWith('/api')) return res.status(500).json({ error: 'Error interno' });
    res.status(500).send('Error interno del servidor');
  });

  app.locals.store = store;
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
