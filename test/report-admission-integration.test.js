// Integration tests for the unified report-admission flow (GitHub #87).
//
// The unit tests (report-admission.test.js) prove the shared rules with fakes.
// These prove the three PUBLIC surfaces are all thin adapters over that same
// service, so the behavior differences #87 called out are gone:
//
//   - Subscriber notification is consistent across web, API and WhatsApp.
//   - The reporter's own contact is skipped (self-echo) for email and WhatsApp.
//   - external_id upsert resolves the real owner before notifying.
//   - The duplicate check runs before a report photo is indexed on every path.
//
// Runs against the real Express app + in-memory SQLite, with fake SendGrid /
// WhatsApp / matcher. NOTIFY_MODE=direct so a verified subscriber's alert
// actually lands at a destination we can read (relay mode is covered by
// relay.test.js). No real credentials, network or personal data.
const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { nullMatcher } = require('../src/faces');
const { handleInbound } = require('../src/bot');
const { fakeSendgrid, fakeWhatsApp } = require('./helpers');

// Bytes-identical photos are the "same face"; anything else is a miss. Enough
// to exercise the index-then-search path without Rekognition.
function fakeMatcher() {
  const indexed = new Map();
  let n = 0;
  const key = (b) => b.toString('utf8');
  return {
    enabled: true,
    status: 'activo (fake)',
    async ensureReady() {},
    async indexFace(bytes) {
      const id = `face-${++n}`;
      if (!indexed.has(key(bytes))) indexed.set(key(bytes), []);
      indexed.get(key(bytes)).push(id);
      return { faceId: id, geometry: null };
    },
    async detectFace() {
      return null;
    },
    async searchByImage(bytes) {
      return (indexed.get(key(bytes)) || []).map((faceId) => ({ faceId, similarity: 97 }));
    }
  };
}

async function startApp(matcher) {
  const app = await createApp(await createSqliteAdapter(':memory:'), matcher || nullMatcher);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}`, store: app.locals.store };
}

// Real JPEG bytes, small and upright so toMatchable passes them through
// unchanged — the fake matcher keys faces by exact bytes.
const jpegCache = new Map();
async function photoBytes(label) {
  if (!jpegCache.has(label)) {
    let h = 0;
    for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) % 16777216;
    jpegCache.set(
      label,
      await sharp({
        create: { width: 200, height: 260, channels: 3, background: { r: (h >> 16) & 255, g: (h >> 8) & 255, b: h & 255 } }
      })
        .jpeg()
        .toBuffer()
    );
  }
  return jpegCache.get(label);
}

const emailTos = (sg) => sg.received.map((m) => m.body.personalizations[0].to[0].email);
const waTos = (wa) => wa.received.map((m) => m.body.to);

async function verifiedEmailSub(store, personId, address) {
  const { sub } = await store.subscribe(personId, 'email', address);
  await store.verifySubscription(sub.verify_token);
  return sub;
}

// -------------------------------------------------- consistent notification

test('web, API and WhatsApp reports all notify the same verified subscriber', async (t) => {
  const sg = await fakeSendgrid();
  const wa = await fakeWhatsApp();
  process.env.NOTIFY_MODE = 'direct';
  const app = await startApp(fakeMatcher());
  t.after(() => {
    sg.stop();
    wa.stop();
    app.server.close();
    delete process.env.NOTIFY_MODE;
  });

  // A person with one verified email subscriber, watching for any new update.
  const { person } = await app.store.findOrCreatePerson('Camilo Andrés Restrepo');
  await verifiedEmailSub(app.store, person.id, 'observador@ejemplo.com');

  // 1) API report.
  sg.received.length = 0;
  await fetch(`${app.base}/api/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Camilo Andrés Restrepo', status: 'injured', message: 'por API' })
  });
  assert.deepEqual(emailTos(sg), ['observador@ejemplo.com'], 'la API notifica al suscriptor');

  // 2) WhatsApp report (bot uses the same service).
  sg.received.length = 0;
  await handleInbound(app.store, {
    channel: 'whatsapp',
    from: '573009998888',
    text: 'HERIDO Camilo Andrés Restrepo: por WhatsApp',
    matcher: nullMatcher
  });
  assert.deepEqual(emailTos(sg), ['observador@ejemplo.com'], 'WhatsApp notifica al mismo suscriptor');

  // 3) Web report.
  sg.received.length = 0;
  const fd = new FormData();
  fd.set('name', 'Camilo Andrés Restrepo');
  fd.set('location', 'Barrio Centro');
  fd.set('contact', '300 123 4567');
  fd.append('photos', new File([Buffer.from('web-foto')], 'f.jpg', { type: 'image/jpeg' }));
  const webRes = await fetch(`${app.base}/report`, { method: 'POST', body: fd, redirect: 'manual' });
  assert.equal(webRes.status, 303);
  assert.deepEqual(emailTos(sg), ['observador@ejemplo.com'], 'el formulario web notifica al mismo suscriptor');

  // WhatsApp channel stayed empty throughout — the only sub was email.
  assert.deepEqual(waTos(wa), []);
});

// ------------------------------------------------ reporter self-echo skipped

test('the reporter is not echoed their own report — email (web) and WhatsApp (bot)', async (t) => {
  const sg = await fakeSendgrid();
  const wa = await fakeWhatsApp();
  process.env.NOTIFY_MODE = 'direct';
  const app = await startApp(fakeMatcher());
  t.after(() => {
    sg.stop();
    wa.stop();
    app.server.close();
    delete process.env.NOTIFY_MODE;
  });

  const { person } = await app.store.findOrCreatePerson('Lucía Fernanda Peña');
  // The reporter is ALSO a verified subscriber, under both an email and a phone.
  await verifiedEmailSub(app.store, person.id, 'reportante@ejemplo.com');
  const { sub: waSub } = await app.store.subscribe(person.id, 'whatsapp', '573001112222');
  await app.store.verifySubscription(waSub.verify_token);
  // A different observer that SHOULD hear about every update.
  await verifiedEmailSub(app.store, person.id, 'otro@ejemplo.com');

  // Web report whose contact email is the reporter's own subscription address.
  sg.received.length = 0;
  const fd = new FormData();
  fd.set('name', 'Lucía Fernanda Peña');
  fd.set('location', 'La Candelaria');
  fd.set('contact_email', 'reportante@ejemplo.com');
  fd.append('photos', new File([Buffer.from('foto-web')], 'f.jpg', { type: 'image/jpeg' }));
  await fetch(`${app.base}/report`, { method: 'POST', body: fd, redirect: 'manual' });
  assert.deepEqual(
    emailTos(sg).sort(),
    ['otro@ejemplo.com'],
    'el reportante web no debe recibir su propio reporte; el otro observador sí'
  );

  // WhatsApp report FROM the reporter's own number: their WhatsApp sub must
  // not be echoed. The bot only knows the sender's phone, so it skips exactly
  // that address — an unrelated email sub is not something it can associate,
  // and is notified normally.
  sg.received.length = 0;
  wa.received.length = 0;
  await handleInbound(app.store, {
    channel: 'whatsapp',
    from: '573001112222',
    text: 'BIEN Lucía Fernanda Peña: la vi en el albergue',
    matcher: nullMatcher
  });
  assert.deepEqual(waTos(wa), [], 'el número que reporta no se auto-notifica por WhatsApp');
  assert.deepEqual(
    emailTos(sg).sort(),
    ['otro@ejemplo.com', 'reportante@ejemplo.com'],
    'los suscriptores por correo reciben el aviso; solo el número que reporta se omite'
  );
});

// -------------------------------------- external_id owner resolution + notify

test('external_id upsert notifies the REAL owner, not the drifted name lookup', async (t) => {
  const sg = await fakeSendgrid();
  process.env.NOTIFY_MODE = 'direct';
  const app = await startApp(fakeMatcher());
  t.after(() => {
    sg.stop();
    app.server.close();
    delete process.env.NOTIFY_MODE;
  });

  // Seed an owner via external_id, with a verified subscriber watching it.
  const first = await fetch(`${app.base}/api/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Registro Uno', status: 'missing', external_id: 'ext-100' })
  });
  const firstBody = await first.json();
  const ownerId = firstBody.person_id;
  await verifiedEmailSub(app.store, ownerId, 'sigue-al-owner@ejemplo.com');

  // Re-POST the SAME external_id under a drifted name. The upsert must land on
  // the original owner and notify ITS subscriber.
  sg.received.length = 0;
  const second = await fetch(`${app.base}/api/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Registro Uno Con Nombre Distinto', status: 'safe', external_id: 'ext-100' })
  });
  const secondBody = await second.json();
  assert.equal(secondBody.person_id, ownerId, 'la actualización debe seguir sobre el owner original');
  assert.equal(secondBody.duplicate.merged_into_existing_person, true);
  assert.deepEqual(emailTos(sg), ['sigue-al-owner@ejemplo.com'], 'el aviso va al suscriptor del owner real');
});

// ------------------------------- duplicate check before indexing (API + web)

test('a face duplicate surfaces without a photo matching itself (dup check before indexing)', async (t) => {
  const sg = await fakeSendgrid();
  const matcher = fakeMatcher();
  const app = await startApp(matcher);
  t.after(() => {
    sg.stop();
    app.server.close();
  });

  const face = await photoBytes('rostro-compartido');

  // First person filed with the shared face, via API.
  await fetch(`${app.base}/api/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Primera Persona Reportada',
      status: 'missing',
      photo: { base64: face.toString('base64'), content_type: 'image/jpeg' }
    })
  });

  // A SECOND person, different name, same face — the API should flag a face
  // duplicate. If the dup check ran AFTER indexing, this report's own freshly
  // indexed photo would match itself; excludePersonId + before-index ordering
  // means the only face hit is the OTHER person.
  const res = await fetch(`${app.base}/api/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Segunda Persona Distinta',
      status: 'missing',
      photo: { base64: face.toString('base64'), content_type: 'image/jpeg' }
    })
  });
  const body = await res.json();
  const faceHits = body.duplicate.candidates.filter((c) => c.reason === 'face');
  assert.equal(faceHits.length, 1, 'debe verse exactamente el reporte anterior, no el propio');
  assert.equal(faceHits[0].full_name, 'Primera Persona Reportada');
  // The candidate is never the person just created (no self-match).
  assert.notEqual(String(faceHits[0].person_id), String(body.person_id));
});
