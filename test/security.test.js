const test = require('node:test');
const assert = require('node:assert');
const env = require('../src/env');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { nullMatcher } = require('../src/faces');

async function startApp() {
  const app = await createApp(await createSqliteAdapter(':memory:'), nullMatcher);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

test('GET /api/diag never sends email, even with ?email=', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const res = await fetch(`${base}/api/diag?email=victima@ejemplo.com`);
  assert.equal(res.status, 200);
  const body = await res.json();
  // No side-effecting "test" field: a GET must stay read-only.
  assert.equal(body.email.test, undefined);
});

test('POST /api/reindex requires the API key when one is configured', async (t) => {
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    env.API_KEY = '';
  });
  env.API_KEY = 'secreta-de-prueba';

  const noAuth = await fetch(`${base}/api/reindex`, { method: 'POST' });
  assert.equal(noAuth.status, 401);

  const wrongAuth = await fetch(`${base}/api/reindex`, {
    method: 'POST',
    headers: { Authorization: 'Bearer llave-equivocada' }
  });
  assert.equal(wrongAuth.status, 401);

  const okAuth = await fetch(`${base}/api/reindex`, {
    method: 'POST',
    headers: { Authorization: 'Bearer secreta-de-prueba' }
  });
  assert.equal(okAuth.status, 200);
});

test('POST /api/reindex stays open when no API key is configured (unchanged default)', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const res = await fetch(`${base}/api/reindex`, { method: 'POST' });
  assert.equal(res.status, 200);
});

test('POST /api/diag/test-email requires the API key and sends when authorized', async (t) => {
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    env.API_KEY = '';
  });
  env.API_KEY = 'secreta-de-prueba';

  const noAuth = await fetch(`${base}/api/diag/test-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'a@example.com' })
  });
  assert.equal(noAuth.status, 401);

  const okAuth = await fetch(`${base}/api/diag/test-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secreta-de-prueba' },
    body: JSON.stringify({ email: 'a@example.com' })
  });
  assert.equal(okAuth.status, 200);
  const body = await okAuth.json();
  assert.ok('test' in body.email);
});
