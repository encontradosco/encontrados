const test = require('node:test');
const assert = require('node:assert');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createStore } = require('../src/people');
const { notifySubscribers } = require('../src/notify');
const { createApp } = require('../src/server');
const { nullMatcher } = require('../src/faces');

async function freshStore() {
  return createStore(await createSqliteAdapter(':memory:'));
}

test('email subscriptions start unverified and get no alerts until verified', async () => {
  const store = await freshStore();
  const { person } = await store.findOrCreatePerson('Carlos Ruiz');

  const { sub, needsVerification } = await store.subscribe(person.id, 'email', 'Fam@Ejemplo.com');
  assert.equal(needsVerification, true);
  assert.equal(sub.verified, 0);
  assert.equal(sub.address, 'fam@ejemplo.com');
  assert.ok(sub.verify_token.length >= 32);

  const update = await store.addUpdate(person.id, { status: 'safe', source: 'web' });
  // unverified → zero notifications attempted
  assert.equal(await notifySubscribers(store, person, update), 0);

  const verified = await store.verifySubscription(sub.verify_token);
  assert.equal(verified.id, sub.id);
  assert.equal(await notifySubscribers(store, person, update), 1);
});

test('whatsapp subscriptions are auto-verified and carry an unsubscribe token', async () => {
  const store = await freshStore();
  const { person } = await store.findOrCreatePerson('Lucía Mora');
  const { sub, needsVerification } = await store.subscribe(person.id, 'whatsapp', '573001234567');
  assert.equal(needsVerification, false);
  assert.ok(sub.verified);
  assert.ok(sub.verify_token);
});

test('unsubscribe by token deletes the subscription', async () => {
  const store = await freshStore();
  const { person } = await store.findOrCreatePerson('Pablo Neira');
  const { sub } = await store.subscribe(person.id, 'whatsapp', '573009999999');
  const removed = await store.unsubscribeByToken(sub.verify_token);
  assert.equal(removed.id, sub.id);
  assert.equal((await store.getSubscriptions(person.id)).length, 0);
  assert.equal(await store.unsubscribeByToken(sub.verify_token), null);
});

test('web flow: subscribe → check email → verify link → unsubscribe link', async (t) => {
  const app = await createApp(await createSqliteAdapter(':memory:'), nullMatcher);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const store = app.locals.store;

  const { person } = await store.findOrCreatePerson('Elena Vargas');
  const res = await fetch(`${base}/person/${person.id}/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'elena.familia@ejemplo.com' }),
    redirect: 'manual'
  });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /checkemail=1/);

  const [sub] = await store.getSubscriptions(person.id);
  assert.equal(sub.verified, 0);

  const verify = await fetch(`${base}/verify?token=${sub.verify_token}`, { redirect: 'manual' });
  assert.equal(verify.status, 302);
  assert.match(verify.headers.get('location'), /subscribed=1/);
  assert.ok((await store.getSubscriptions(person.id))[0].verified);

  const unsub = await fetch(`${base}/unsubscribe?token=${sub.verify_token}`);
  assert.equal(unsub.status, 200);
  assert.match(await unsub.text(), /ya no recibirás avisos/);
  assert.equal((await store.getSubscriptions(person.id)).length, 0);

  const badToken = await fetch(`${base}/verify?token=nope`);
  assert.equal(badToken.status, 404);
});
