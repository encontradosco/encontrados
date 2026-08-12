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

// ---- POST /webhooks/whatsapp: credencial del relevo ----
//
// El POST escribe en la base (crea personas, updates y suscripciones), así que
// exige la credencial del relevo. El GET del handshake es una lectura y sigue
// abierto.

const RELAY_SECRET = 'secreto-de-relevo-de-prueba';

function inboundBody(name) {
  return JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              messages: [{ type: 'text', from: '573000000000', text: { body: `BIEN ${name}` } }]
            }
          }
        ]
      }
    ]
  });
}

test('POST /webhooks/whatsapp rejects a request without the relay credential', async (t) => {
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    delete process.env.WHATSAPP_RELAY_SECRET;
  });
  process.env.WHATSAPP_RELAY_SECRET = RELAY_SECRET;

  const res = await fetch(`${base}/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: inboundBody('Camila Restrepo')
  });
  assert.equal(res.status, 403);

  // And nothing reached the database.
  await new Promise((r) => setTimeout(r, 150));
  const { results } = await (await fetch(`${base}/api/people?q=camila restrepo`)).json();
  assert.equal(results.length, 0);
});

test('POST /webhooks/whatsapp rejects a wrong relay credential', async (t) => {
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    delete process.env.WHATSAPP_RELAY_SECRET;
  });
  process.env.WHATSAPP_RELAY_SECRET = RELAY_SECRET;

  const res = await fetch(`${base}/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Relay-Secret': 'credencial-equivocada' },
    body: inboundBody('Camila Restrepo')
  });
  assert.equal(res.status, 403);

  await new Promise((r) => setTimeout(r, 150));
  const { results } = await (await fetch(`${base}/api/people?q=camila restrepo`)).json();
  assert.equal(results.length, 0);
});

test('POST /webhooks/whatsapp accepts the relay credential and processes the message', async (t) => {
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    delete process.env.WHATSAPP_RELAY_SECRET;
  });
  process.env.WHATSAPP_RELAY_SECRET = RELAY_SECRET;

  const res = await fetch(`${base}/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Relay-Secret': RELAY_SECRET },
    body: inboundBody('Camila Restrepo')
  });
  assert.equal(res.status, 200);

  // 200 alone would also be the answer to a body that failed downstream, so
  // check that the message actually landed.
  await new Promise((r) => setTimeout(r, 150));
  const { results } = await (await fetch(`${base}/api/people?q=camila restrepo`)).json();
  assert.equal(results.length, 1);
  assert.equal(results[0].latest_update.source, 'whatsapp');
});

test('POST /webhooks/whatsapp rejects everything when no relay secret is configured', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());
  delete process.env.WHATSAPP_RELAY_SECRET;

  // Unconfigured fails CLOSED: not even a request carrying a credential gets in,
  // because there is nothing to compare it against.
  const noHeader = await fetch(`${base}/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: inboundBody('Camila Restrepo')
  });
  assert.equal(noHeader.status, 403);

  const withHeader = await fetch(`${base}/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Relay-Secret': RELAY_SECRET },
    body: inboundBody('Camila Restrepo')
  });
  assert.equal(withHeader.status, 403);

  await new Promise((r) => setTimeout(r, 150));
  const { results } = await (await fetch(`${base}/api/people?q=camila restrepo`)).json();
  assert.equal(results.length, 0);
});

test('GET /webhooks/whatsapp handshake stays open without the relay credential', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const res = await fetch(
    `${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${env.WHATSAPP_VERIFY_TOKEN}&hub.challenge=reto-123`
  );
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'reto-123');
});
