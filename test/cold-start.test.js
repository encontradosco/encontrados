const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const serverModule = require('../src/server');
const realCreateApp = serverModule.createApp;
const handlerPath = require.resolve('../api/index.js');

// api/index.js destructures createApp when it loads, so the stand-in has to be
// in place BEFORE the require. A fresh require also gives each test its own
// module instance, which is what holds the cached app promise.
function loadHandler(createApp) {
  serverModule.createApp = createApp;
  delete require.cache[handlerPath];
  try {
    return require(handlerPath);
  } finally {
    serverModule.createApp = realCreateApp;
    delete require.cache[handlerPath];
  }
}

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// Silence (and capture) the boot log so a passing suite isn't full of stack
// traces from failures the tests caused on purpose.
function captureErrors(t) {
  const logged = [];
  const real = console.error;
  console.error = (...args) => logged.push(args);
  t.after(() => {
    console.error = real;
  });
  return logged;
}

// 11-ago-2026: every route, /health included, answered 500 for minutes while
// the database was already healthy again. createApp() opens the database
// before registering routes, and the rejected promise stayed cached, so that
// instance never recovered on its own.
test('a failed boot does not stick: the next request builds the app again', async (t) => {
  const logged = captureErrors(t);
  let builds = 0;
  const handler = loadHandler(async () => {
    builds++;
    if (builds === 1) throw new Error('la base no responde');
    return (req, res) => {
      res.statusCode = 200;
      res.end('viva');
    };
  });
  const { server, base } = await serve(handler);
  t.after(() => server.close());

  const first = await fetch(`${base}/health`);
  assert.equal(first.status, 503, 'el arranque fallido no puede volverse un 500 crudo');
  assert.match(await first.text(), /Vuelve a intentarlo/);

  const second = await fetch(`${base}/health`);
  assert.equal(second.status, 200, 'la instancia tiene que recuperarse sola');
  assert.equal(await second.text(), 'viva');
  assert.equal(builds, 2, 'la segunda petición vuelve a construir la app');

  const third = await fetch(`${base}/health`);
  assert.equal(third.status, 200);
  assert.equal(builds, 2, 'una vez construida, se reutiliza');

  assert.equal(logged.length, 1, 'el fallo queda en los logs de Vercel, no solo en el 503');
  assert.match(String(logged[0][0]), /\[boot\]/);
});

// The whole point of caching the promise is that a burst of requests hitting a
// cold instance opens one connection, not one per request. Clearing on failure
// must not cost that.
test('requests racing a cold start still share a single build attempt', async (t) => {
  captureErrors(t);
  let builds = 0;
  const handler = loadHandler(async () => {
    builds++;
    await new Promise((r) => setTimeout(r, 20));
    if (builds === 1) throw new Error('la base no responde');
    return (req, res) => {
      res.statusCode = 200;
      res.end('viva');
    };
  });
  const { server, base } = await serve(handler);
  t.after(() => server.close());

  const burst = await Promise.all([1, 2, 3].map(() => fetch(`${base}/`)));
  assert.deepEqual(
    burst.map((r) => r.status),
    [503, 503, 503]
  );
  assert.equal(builds, 1, 'tres peticiones concurrentes no abren tres arranques');

  const after = await fetch(`${base}/`);
  assert.equal(after.status, 200);
  assert.equal(builds, 2);
});
