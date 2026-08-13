// Unit tests for src/notify.js — no HTTP app, no SQLite adapters beyond what
// notifySubscribers itself needs (getSubscriptions), fake SendGrid for the
// real "sent" path. Synthetic names only, per repo convention.
const test = require('node:test');
const assert = require('node:assert');
const { notifySubscribers } = require('../src/notify');
const { fakeSendgrid } = require('./helpers');

// Enough of the store surface notifySubscribers touches: subscriptions in,
// contact-log writes swallowed (logContact tolerates a missing table by
// design — see src/logbook.js — but a fake store makes the test explicit
// about exactly what's exercised).
function fakeStoreWithSubs(subs) {
  return {
    async getSubscriptions() {
      return subs;
    },
    async insertContactLog() {}
  };
}

test('notifySubscribers counts DELIVERED messages, not attempts', async (t) => {
  const sg = await fakeSendgrid();
  process.env.NOTIFY_MODE = 'direct';
  t.after(() => {
    sg.stop();
    delete process.env.NOTIFY_MODE;
  });

  const person = { id: 321, full_name: 'Persona Prueba Notificaciones' };
  const update = { id: 654, status: 'safe', message: null, location: null };
  // Two verified subscribers: the email one is delivered by the fake
  // SendGrid; the WhatsApp one fails because WhatsApp isn't configured in
  // this test (no WHATSAPP_TOKEN) — same as production without credentials.
  const store = fakeStoreWithSubs([
    { channel: 'email', address: 'observador@ejemplo.com', verified: true, verify_token: 'tok-1' },
    { channel: 'whatsapp', address: '573000000000', verified: true, verify_token: 'tok-2' }
  ]);

  const notified = await notifySubscribers(store, person, update, {});

  assert.equal(sg.received.length, 1, 'el correo sí debe salir');
  assert.equal(
    notified,
    1,
    'notified debe contar SOLO la entrega que salió — el intento a WhatsApp sin configurar no cuenta como enviado'
  );
});

test('notifySubscribers returns 0 when every attempt fails, not the attempt count', async (t) => {
  process.env.NOTIFY_MODE = 'direct';
  t.after(() => {
    delete process.env.NOTIFY_MODE;
  });

  const person = { id: 322, full_name: 'Persona Prueba Sin Entregas' };
  const update = { id: 655, status: 'missing', message: null, location: null };
  // Two verified subscribers, neither channel configured (no SendGrid key,
  // no WhatsApp token): both attempts happen, neither is delivered.
  const store = fakeStoreWithSubs([
    { channel: 'email', address: 'uno@ejemplo.com', verified: true, verify_token: 'tok-3' },
    { channel: 'whatsapp', address: '573000000001', verified: true, verify_token: 'tok-4' }
  ]);

  const notified = await notifySubscribers(store, person, update, {});
  assert.equal(notified, 0, 'dos intentos fallidos deben contar como 0 entregas, no como 2');
});
