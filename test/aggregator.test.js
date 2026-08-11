const test = require('node:test');
const assert = require('node:assert');
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

function postUpdate(base, body) {
  return fetch(`${base}/api/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

test('API: POST /api/updates with a repeated external_id is idempotent', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const first = await postUpdate(base, {
    name: 'Carlos Andrés Ruiz',
    status: 'missing',
    message: 'Visto por última vez en el barrio',
    external_id: 'agg-123'
  });
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  assert.equal(firstBody.update.status, 'missing');

  // Same external_id, updated status/message — must land on the SAME update,
  // not create a second one.
  const second = await postUpdate(base, {
    name: 'Carlos Andrés Ruiz',
    status: 'safe',
    message: 'Confirmado por la Cruz Roja',
    external_id: 'agg-123'
  });
  assert.equal(second.status, 201);
  const secondBody = await second.json();
  assert.equal(secondBody.update.id, firstBody.update.id);
  assert.equal(secondBody.update.status, 'safe');
  assert.equal(secondBody.update.message, 'Confirmado por la Cruz Roja');

  const detail = await fetch(`${base}/api/people/${secondBody.person_id}`);
  const person = await detail.json();
  assert.equal(person.updates.length, 1, 'no debe crear un segundo update con el mismo external_id');
  assert.equal(person.updates[0].status, 'safe');
});

test('API: POST /api/updates persists source=aggregator', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const res = await postUpdate(base, {
    name: 'Diana Marcela Ortiz',
    status: 'safe',
    source: 'aggregator'
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.update.source, 'aggregator');

  const detail = await fetch(`${base}/api/people/${body.person_id}`);
  const person = await detail.json();
  assert.equal(person.updates[0].source, 'aggregator');
});

test('API: source defaults to "api" when omitted or invalid', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const omitted = await postUpdate(base, { name: 'Luis Fernando Peña', status: 'safe' });
  assert.equal((await omitted.json()).update.source, 'api');

  const invalid = await postUpdate(base, {
    name: 'Otra Persona Cualquiera',
    status: 'safe',
    source: 'algo-inventado'
  });
  assert.equal((await invalid.json()).update.source, 'api');
});

test('API: without external_id, behavior is unchanged (each POST creates a new update)', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  await postUpdate(base, { name: 'Repetida Sin Id', status: 'safe' });
  const second = await postUpdate(base, { name: 'Repetida Sin Id', status: 'injured' });
  const secondBody = await second.json();

  const detail = await fetch(`${base}/api/people/${secondBody.person_id}`);
  const person = await detail.json();
  assert.equal(person.updates.length, 2, 'sin external_id cada POST debe seguir creando un update nuevo');
});
