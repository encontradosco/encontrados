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

// #118: un texto sin comando ya no se convierte en búsqueda por nombre.
test('bare text without a command is not a search', () => {
  const p = parseMessage('Juan Pérez');
  assert.equal(p.intent, 'unrecognized');
});

test('free text never touches the store and is not echoed back (#118)', async () => {
  const store = await freshStore();
  let searched = false;
  const spied = new Proxy(store, {
    get(target, prop) {
      if (prop === 'searchPeople') {
        return (...args) => {
          searched = true;
          return target.searchPeople(...args);
        };
      }
      return target[prop];
    }
  });
  const phrase =
    'La plataforma me mostró una coincidencia alta pero no aparecen datos de quien la busca, qué hago';
  const reply = await handleInbound(spied, {
    channel: 'whatsapp',
    from: '573009998877',
    text: phrase
  });
  assert.equal(searched, false, 'free text must never call searchPeople');
  assert.ok(!reply.includes(phrase), 'the reply must not echo the user phrase');
  assert.ok(!/No encontré reportes/.test(reply), 'the reply must not look like a search result');
  assert.match(reply, /BUSCAR/);
  assert.match(reply, /AYUDA/);
});

test('explicit BUSCAR keyword still searches (#118)', async () => {
  const store = await freshStore();
  await handleInbound(store, { channel: 'whatsapp', from: '1', text: 'BIEN Persona Prueba Uno' });
  const r = await handleInbound(store, { channel: 'whatsapp', from: '2', text: 'BUSCAR Persona Prueba Uno' });
  assert.match(r, /Persona Prueba Uno/);
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
  const r = await handleInbound(store, { channel: 'whatsapp', from: '99', text: 'ayuda' });
  assert.match(r, /Comandos/);
});
