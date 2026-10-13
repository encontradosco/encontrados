// Los avisos al equipo en el canal privado de Discord (src/discord.js).
//
// Lo que estas pruebas protegen:
//   - con DISCORD_AVISOS_WEBHOOK_URL puesta, el aviso va SOLO a Discord — ni
//     una copia al correo, aunque AVISO_EMAIL siga configurada;
//   - sin ella, todo sigue por correo como antes (el orden del despliegue no
//     importa);
//   - cada mensaje queda registrado por su id, y la purga lo borra a los 30
//     días con la credencial del mismo webhook — y solo entonces;
//   - nada de lo que escribe alguien de afuera puede mencionar a nadie;
//   - sin credenciales de WhatsApp la app no le contesta a nadie por ese canal.
// Nombres sintéticos, siempre.
const test = require('node:test');
const assert = require('node:assert');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createStore } = require('../src/people');
const { createApp } = require('../src/server');
const { nullMatcher } = require('../src/faces');
const { relayToOperators } = require('../src/notify');
const { purgeExpiredAvisos, splitForDiscord, webhookIdOf, RETENTION_DAYS } = require('../src/discord');
const { fakeSendgrid, fakeDiscordWebhook, fakeWhatsApp } = require('./helpers');

const DAY = 24 * 60 * 60 * 1000;

async function startApp() {
  const app = await createApp(await createSqliteAdapter(':memory:'), nullMatcher);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}`, store: app.locals.store };
}

async function memoryStore() {
  return createStore(await createSqliteAdapter(':memory:'));
}

function posts(discord) {
  return discord.received.filter((r) => r.method === 'POST');
}

test('el aviso de un rescatista va al canal privado de Discord y NO al correo', async (t) => {
  const discord = await fakeDiscordWebhook();
  const sg = await fakeSendgrid();
  process.env.AVISO_EMAIL = 'avisos@example.com';
  const { server, base, store } = await startApp();
  t.after(() => {
    discord.stop();
    sg.stop();
    delete process.env.AVISO_EMAIL;
    server.close();
  });

  const { person } = await store.findOrCreatePerson('Persona Prueba Discord');
  const res = await fetch(`${base}/rescate/aviso`, {
    method: 'POST',
    body: new URLSearchParams({
      person_id: String(person.id),
      phone: '300 000 0000',
      location: 'Albergue de prueba, @everyone'
    })
  });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Aviso enviado/);

  const sent = posts(discord);
  assert.equal(sent.length, 1, 'un aviso, un mensaje');
  assert.match(sent[0].url, /[?&]wait=true/, 'sin wait=true Discord no devuelve el id y el mensaje no se podría borrar');
  const { content, allowed_mentions: mentions, flags } = sent[0].body;
  assert.match(content, /Aviso de rescatista — Persona Prueba Discord/);
  assert.match(content, /300 000 0000/);
  assert.match(content, /Dónde puede ser localizada: Albergue de prueba/);
  assert.deepEqual(mentions, { parse: [] }, 'un "@everyone" escrito por alguien de afuera no puede notificar a nadie');
  assert.equal(flags & 4, 4, 'sin vistas previas de enlaces');

  assert.equal(sg.received.length, 0, 'con Discord configurado, el correo no se usa: un aviso tiene UN destino');

  // Quedó registrado para su borrado.
  const rows = await store.listExpiredDiscordAvisos({
    webhookId: '111222333',
    before: new Date(Date.now() + DAY).toISOString()
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].message_id, [...discord.live][0]);

  // Y la bitácora lo cuenta como relevo enviado, igual que con el correo.
  const relevo = (await store.contactLogCounts()).find((r) => r.channel === 'relevo');
  assert.equal(relevo.result, 'enviado');
});

test('sin DISCORD_AVISOS_WEBHOOK_URL el aviso sigue yendo al correo, como antes', async (t) => {
  delete process.env.DISCORD_AVISOS_WEBHOOK_URL;
  const sg = await fakeSendgrid();
  process.env.AVISO_EMAIL = 'avisos@example.com';
  const { server, base, store } = await startApp();
  t.after(() => {
    sg.stop();
    delete process.env.AVISO_EMAIL;
    server.close();
  });

  const { person } = await store.findOrCreatePerson('Persona Prueba Correo');
  const res = await fetch(`${base}/rescate/aviso`, {
    method: 'POST',
    body: new URLSearchParams({ person_id: String(person.id), phone: '300 000 0001', location: 'Coliseo de prueba' })
  });
  assert.equal(res.status, 200);
  const mail = sg.received.find((r) => JSON.stringify(r.body).includes('avisos@example.com'));
  assert.ok(mail, 'el respaldo por correo tiene que seguir vivo mientras la variable no esté');
});

test('si Discord falla, el aviso no se duplica por correo y el fallo queda en la bitácora', async (t) => {
  const discord = await fakeDiscordWebhook();
  const sg = await fakeSendgrid();
  process.env.AVISO_EMAIL = 'avisos@example.com';
  const { server, base, store } = await startApp();
  t.after(() => {
    discord.stop();
    sg.stop();
    delete process.env.AVISO_EMAIL;
    server.close();
  });

  discord.failNext(500);
  const { person } = await store.findOrCreatePerson('Persona Prueba Falla');
  const res = await fetch(`${base}/rescate/aviso`, {
    method: 'POST',
    body: new URLSearchParams({ person_id: String(person.id), phone: '300 000 0002', location: 'Hospital de prueba' })
  });
  assert.equal(res.status, 200, 'quien avisa no carga con nuestro problema: el aviso ya quedó en la ficha');
  assert.equal(sg.received.length, 0);
  const relevo = (await store.contactLogCounts()).find((r) => r.channel === 'relevo');
  assert.equal(relevo.result, 'fallido', 'nunca se finge que salió algo que no salió');
});

test('un aviso retenido por el relevo también va a Discord, y uno largo se parte sin perder nada', async (t) => {
  const discord = await fakeDiscordWebhook();
  t.after(() => discord.stop());
  const store = await memoryStore();

  const longText = Array.from({ length: 80 }, (_, i) => `Línea de prueba número ${i} con algo de relleno para alargarla.`).join('\n');
  const result = await relayToOperators({
    store,
    reason: 'Prueba de relevo',
    channel: 'email',
    address: 'destinatario@ejemplo.com',
    subject: 'Asunto de prueba',
    text: longText,
    person: { id: 7, full_name: 'Persona Prueba Relevo' }
  });
  assert.equal(result.ok, true);
  assert.equal(result.relayed, true);

  const sent = posts(discord);
  assert.ok(sent.length > 1, 'un texto de más de 2000 caracteres no cabe en un mensaje');
  for (const s of sent) assert.ok(s.body.content.length <= 2000, 'Discord rechaza mensajes de más de 2000 caracteres');
  const joined = sent.map((s) => s.body.content).join('\n');
  assert.match(joined, /\[RETENIDO\] Prueba de relevo — Persona Prueba Relevo/);
  assert.match(joined, /Línea de prueba número 0 /);
  assert.match(joined, /Línea de prueba número 79 /);
  assert.match(sent[0].body.content, /parte 1\//);

  const rows = await store.listExpiredDiscordAvisos({
    webhookId: '111222333',
    before: new Date(Date.now() + DAY).toISOString()
  });
  assert.equal(rows.length, sent.length, 'cada parte queda registrada para borrarse');
});

test('splitForDiscord no pierde texto, ni siquiera con una línea gigante', () => {
  const huge = 'x'.repeat(4500);
  const chunks = splitForDiscord(`inicio\n${huge}\nfin`);
  assert.ok(chunks.every((c) => c.length <= 1900));
  assert.equal(chunks.join('').replace(/\n/g, ''), `inicio${huge}fin`);
});

test('webhookIdOf saca el id del webhook de su URL', () => {
  assert.equal(webhookIdOf('https://discord.com/api/webhooks/123/abc'), '123');
  assert.equal(webhookIdOf('https://discord.com/api/v10/webhooks/456/def?thread_id=1'), '456');
  assert.equal(webhookIdOf('no es una url'), null);
});

test(`la purga borra a los ${RETENTION_DAYS} días, y solo entonces`, async (t) => {
  const discord = await fakeDiscordWebhook();
  t.after(() => discord.stop());
  const store = await memoryStore();

  for (let i = 0; i < 4; i++) {
    await relayToOperators({
      store,
      reason: `Prueba ${i}`,
      channel: 'email',
      address: 'destinatario@ejemplo.com',
      subject: 's',
      text: 'texto corto',
      person: null
    });
  }
  // Uno que escribió un webhook anterior: este no lo puede borrar.
  await store.insertDiscordAviso({ messageId: '1', webhookId: '999' });
  const ids = [...discord.live];
  assert.equal(ids.length, 4);

  // Hoy no vence nada.
  const today = await purgeExpiredAvisos(store);
  assert.equal(today.candidates, 0);
  assert.equal(discord.received.filter((r) => r.method === 'DELETE').length, 0);

  // Uno lo borró alguien a mano, y el siguiente borrado falla una vez.
  discord.live.delete(ids[0]);
  const later = new Date(Date.now() + (RETENTION_DAYS + 1) * DAY);
  discord.failNext(500);
  const first = await purgeExpiredAvisos(store, { now: later });
  assert.equal(first.candidates, 4);
  assert.equal(first.failed, 1, 'el que falló se reintenta mañana');
  assert.equal(first.alreadyGone + first.deleted, 3);
  assert.equal(first.orphans, 1, 'los de otro webhook se reportan para borrarlos a mano');
  assert.equal(first.ok, false);

  const second = await purgeExpiredAvisos(store, { now: later });
  assert.equal(second.candidates, 1);
  assert.equal(second.deleted + second.alreadyGone, 1);
  assert.equal(discord.live.size, 0, 'no queda ningún mensaje vencido en el canal');

  const third = await purgeExpiredAvisos(store, { now: later });
  assert.equal(third.candidates, 0);
});

test('la purga sigue lote tras lote, y si se le acaba el tiempo lo dice', async (t) => {
  const discord = await fakeDiscordWebhook();
  t.after(() => discord.stop());
  const store = await memoryStore();
  for (let i = 0; i < 7; i++) {
    await relayToOperators({ store, reason: 'r', channel: 'email', address: 'a@ejemplo.com', subject: 's', text: 't', person: null });
  }
  const later = new Date(Date.now() + (RETENTION_DAYS + 1) * DAY);

  // Sin presupuesto: no se presenta como purga completa.
  const none = await purgeExpiredAvisos(store, { now: later, limit: 3, budgetMs: 0 });
  assert.equal(none.pending, true);
  assert.equal(none.ok, false);

  // Un fallo en el primer lote no frena los siguientes ni se vuelve a pedir.
  discord.failNext(500);
  const res = await purgeExpiredAvisos(store, { now: later, limit: 3 });
  assert.equal(res.candidates, 7, 'más allá del primer lote');
  assert.equal(res.deleted, 6);
  assert.equal(res.failed, 1);
  assert.equal(res.pending, false);
  assert.equal(discord.received.filter((r) => r.method === 'DELETE').length, 7, 'el que falló no se reintenta en la misma corrida');

  const next = await purgeExpiredAvisos(store, { now: later, limit: 3 });
  assert.equal(next.deleted, 1);
  assert.equal(next.ok, true);
  assert.equal(discord.live.size, 0);
});

test('la purga se detiene si el webhook ya no existe, sin soltar lo pendiente', async (t) => {
  const discord = await fakeDiscordWebhook();
  t.after(() => discord.stop());
  const store = await memoryStore();
  await relayToOperators({ store, reason: 'r', channel: 'email', address: 'a@ejemplo.com', subject: 's', text: 't', person: null });
  await relayToOperators({ store, reason: 'r', channel: 'email', address: 'a@ejemplo.com', subject: 's', text: 't', person: null });

  const later = new Date(Date.now() + (RETENTION_DAYS + 1) * DAY);
  discord.failNext(404, { message: 'Unknown Webhook', code: 10015 });
  const res = await purgeExpiredAvisos(store, { now: later });
  assert.equal(res.ok, false);
  assert.match(res.stoppedBy, /webhook/);
  assert.equal(discord.received.filter((r) => r.method === 'DELETE').length, 1, 'no insiste con un webhook que no existe');
  const pending = await store.listExpiredDiscordAvisos({ webhookId: '111222333', before: later.toISOString() });
  assert.equal(pending.length, 2, 'siguen siendo mensajes por borrar');
});

test('sin webhook configurado la purga no hace nada y lo dice', async () => {
  delete process.env.DISCORD_AVISOS_WEBHOOK_URL;
  const res = await purgeExpiredAvisos(await memoryStore());
  assert.equal(res.ok, true);
  assert.match(res.skipped, /DISCORD_AVISOS_WEBHOOK_URL/);
});

test('/api/avisos/purge exige credencial (API key o CRON_SECRET)', async (t) => {
  const discord = await fakeDiscordWebhook();
  const { server, base } = await startApp();
  t.after(() => {
    discord.stop();
    delete process.env.CRON_SECRET;
    server.close();
  });

  const open = await fetch(`${base}/api/avisos/purge`);
  assert.equal(open.status, 401, 'tiene efecto de lado: falla cerrado');

  process.env.CRON_SECRET = 'secreto-del-cron';
  const viaCron = await fetch(`${base}/api/avisos/purge`, { headers: { Authorization: 'Bearer secreto-del-cron' } });
  assert.equal(viaCron.status, 200);
  const body = await viaCron.json();
  assert.equal(body.retentionDays, RETENTION_DAYS);
  assert.equal(body.candidates, 0);
  assert.doesNotMatch(JSON.stringify(body), /token-de-prueba/, 'la URL del webhook es una credencial: nunca sale');
});

test('/api/diag dice a dónde van los avisos, sin mostrar la URL del webhook', async (t) => {
  const discord = await fakeDiscordWebhook();
  const { server, base } = await startApp();
  t.after(() => {
    discord.stop();
    server.close();
  });
  const raw = await (await fetch(`${base}/api/diag`)).text();
  const diag = JSON.parse(raw);
  assert.equal(diag.notifications.operator_destination, 'discord');
  assert.equal(diag.notifications.discord_webhook_present, true);
  assert.equal(diag.notifications.relay_without_mailbox, false, 'con Discord, el relevo sí tiene a dónde ir');
  assert.doesNotMatch(raw, /token-de-prueba|111222333/);
});

test('discord_avisos no guarda nada que identifique a una persona', async () => {
  const adapter = await createSqliteAdapter(':memory:');
  const store = createStore(adapter);
  await store.insertDiscordAviso({ messageId: '42', webhookId: '7' });
  const rows = await store.listExpiredDiscordAvisos({ webhookId: '7', before: '9999-12-31T00:00:00Z' });
  assert.deepEqual(Object.keys(rows[0]).sort(), ['created_at', 'message_id', 'webhook_id']);
  assert.match(rows[0].created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'mismo formato ISO en los dos motores');
});

test('sin WHATSAPP_TOKEN la app no le contesta a nadie por WhatsApp', async (t) => {
  // El doble de Meta escucha, pero sin token la app no debe llamarlo nunca.
  const wa = await fakeWhatsApp();
  delete process.env.WHATSAPP_TOKEN;
  delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  process.env.WHATSAPP_RELAY_SECRET = 'secreto-de-relevo-de-prueba';
  const { server, base } = await startApp();
  t.after(() => {
    wa.stop();
    delete process.env.WHATSAPP_RELAY_SECRET;
    server.close();
  });

  const inbound = (body) =>
    fetch(`${base}/webhooks/whatsapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Relay-Secret': 'secreto-de-relevo-de-prueba' },
      body: JSON.stringify({
        entry: [{ changes: [{ value: { messages: [{ type: 'text', from: '570000000000', text: { body } }] } }] }]
      })
    });
  assert.equal((await inbound('AYUDA')).status, 200, 'Meta (o el relevo) siempre recibe su 200');
  assert.equal((await inbound('BIEN Persona Prueba WhatsApp')).status, 200);
  assert.equal(wa.received.length, 0, 'ni una respuesta automática sale sin credenciales');

  // Y sin el secreto del relevo, el webhook no acepta nada en absoluto.
  delete process.env.WHATSAPP_RELAY_SECRET;
  assert.equal((await inbound('AYUDA')).status, 403);
  assert.equal(wa.received.length, 0);
});
