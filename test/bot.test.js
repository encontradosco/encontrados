const test = require('node:test');
const assert = require('node:assert');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createStore } = require('../src/people');
const { handleInbound, parseMessage } = require('../src/bot');

async function freshStore() {
  return createStore(await createSqliteAdapter(':memory:'));
}

test('parseMessage understands report with note and location', () => {
  const p = parseMessage('BIEN Juan Pérez: hablé con él @ albergue San José');
  assert.equal(p.intent, 'report');
  assert.equal(p.status, 'safe');
  assert.equal(p.name, 'Juan Pérez');
  assert.equal(p.note, 'hablé con él');
  assert.equal(p.location, 'albergue San José');
});

test('bare text is treated as a search', () => {
  const p = parseMessage('Juan Pérez');
  assert.equal(p.intent, 'find');
  assert.equal(p.name, 'Juan Pérez');
});

test('report then fuzzy find via WhatsApp flow', async () => {
  const store = await freshStore();
  const r1 = await handleInbound(store, {
    channel: 'whatsapp',
    from: '573001234567',
    text: 'BIEN Juan Carlos Pérez Gómez: está en el albergue'
  });
  assert.match(r1, /Registrado/);

  // Different speller, missing middle names, accent-free
  const r2 = await handleInbound(store, {
    channel: 'whatsapp',
    from: '573007654321',
    text: 'BUSCAR jaun peres'
  });
  assert.match(r2, /Juan Carlos Pérez Gómez/);
  assert.match(r2, /A SALVO/);
});

test('reporting a confidently-matching name merges into the same person', async () => {
  const store = await freshStore();
  await handleInbound(store, { channel: 'whatsapp', from: '1', text: 'BIEN José Pérez Gómez' });
  await handleInbound(store, { channel: 'whatsapp', from: '2', text: 'HERIDO Jose Perez Gomez' });
  const matches = await store.searchPeople('jose perez gomez');
  assert.equal(matches.length, 1);
  const updates = await store.getUpdates(matches[0].id);
  assert.equal(updates.length, 2);
});

test('subscribe registers the sender phone; unsubscribe removes it', async () => {
  const store = await freshStore();
  const phone = '573001112233';
  const r = await handleInbound(store, { channel: 'whatsapp', from: phone, text: 'SUSCRIBIR Ana María Ruiz' });
  assert.match(r, /Te avisaré a este número/);
  const [person] = await store.searchPeople('ana maria ruiz');
  const subs = await store.getSubscriptions(person.id);
  assert.deepEqual(
    subs.map((s) => [s.channel, s.address]),
    [['whatsapp', phone]]
  );

  const r2 = await handleInbound(store, { channel: 'whatsapp', from: phone, text: 'BAJA Ana Maria Ruiz' });
  assert.match(r2, /ya no recibirás avisos/);
  assert.equal((await store.getSubscriptions(person.id)).length, 0);
});

test('help for unknown/empty messages', async () => {
  const store = await freshStore();
  const r = await handleInbound(store, { channel: 'telegram', from: '99', text: 'ayuda' });
  assert.match(r, /Comandos/);
});
