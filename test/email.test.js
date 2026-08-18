const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { nullMatcher } = require('../src/faces');
const { fakeWhatsApp } = require('./helpers');

// Stand-in for SendGrid so we can assert a real HTTP send happened.
async function fakeSendgrid() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
      res.writeHead(202).end();
    });
  });
  await new Promise((r) => server.listen(0, r));
  return { server, received, base: `http://127.0.0.1:${server.address().port}` };
}

async function startApp() {
  const app = await createApp(await createSqliteAdapter(':memory:'), nullMatcher);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}`, store: app.locals.store };
}

test('verification email is actually sent before the response returns', async (t) => {
  const sg = await fakeSendgrid();
  const app = await startApp();
  t.after(() => {
    sg.server.close();
    app.server.close();
    delete process.env.SENDGRID_API_KEY;
    delete process.env.SENDGRID_API_BASE;
  });
  process.env.SENDGRID_API_KEY = 'test-key';
  process.env.SENDGRID_API_BASE = sg.base;

  const fd = new FormData();
  fd.set('photo', new File([Buffer.from('foto')], 'r.jpg', { type: 'image/jpeg' }));
  fd.set('email', 'familia@ejemplo.com');
  const res = await fetch(`${app.base}/rescate`, { method: 'POST', body: fd });
  assert.equal(res.status, 200);

  // The send must already have happened — no floating promise, because a
  // serverless function is frozen the moment it responds.
  assert.equal(sg.received.length, 1, 'no se envió el correo de verificación');
  const mail = sg.received[0];
  assert.equal(mail.auth, 'Bearer test-key');
  assert.equal(mail.body.personalizations[0].to[0].email, 'familia@ejemplo.com');
  assert.equal(mail.body.from.email, 'a@torrenegra.com');
  assert.match(mail.body.content[0].value, /\/verify\?token=/);
});

// NOTIFY_MODE=direct: el envío al suscriptor sin relevo. Es el modo que Alex
// puede recuperar con una variable, y tiene que seguir intacto.
test('in direct mode, update alerts reach verified subscribers before the response returns', async (t) => {
  const sg = await fakeSendgrid();
  const app = await startApp();
  t.after(() => {
    sg.server.close();
    app.server.close();
    delete process.env.SENDGRID_API_KEY;
    delete process.env.SENDGRID_API_BASE;
    delete process.env.NOTIFY_MODE;
  });
  process.env.SENDGRID_API_KEY = 'test-key';
  process.env.SENDGRID_API_BASE = sg.base;
  process.env.NOTIFY_MODE = 'direct';

  const { person } = await app.store.findOrCreatePerson('Hernán Duque');
  const { sub } = await app.store.subscribe(person.id, 'email', 'tio@ejemplo.com');
  await app.store.verifySubscription(sub.verify_token);
  sg.received.length = 0;

  const res = await fetch(`${app.base}/api/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Hernán Duque', status: 'safe', message: 'Está en el albergue' })
  });
  assert.equal(res.status, 201);
  assert.equal(sg.received.length, 1, 'no se envió el aviso al suscriptor');
  assert.match(sg.received[0].body.content[0].value, /A SALVO/);
  assert.match(sg.received[0].body.content[0].value, /unsubscribe\?token=/);
});

// #87: POST /api/updates and the WhatsApp bot both fan a new update out to
// anyone already subscribed to that person; POST /report (the web form) used
// to skip this entirely, so whether a family got word of a follow-up report
// depended on which channel it happened to arrive through.
test('POST /report notifies an existing subscriber, same as POST /api/updates', async (t) => {
  const sg = await fakeSendgrid();
  const app = await startApp();
  t.after(() => {
    sg.server.close();
    app.server.close();
    delete process.env.SENDGRID_API_KEY;
    delete process.env.SENDGRID_API_BASE;
  });
  process.env.SENDGRID_API_KEY = 'test-key';
  process.env.SENDGRID_API_BASE = sg.base;
  process.env.NOTIFY_MODE = 'direct';

  const { person } = await app.store.findOrCreatePerson('Rosa Elena Duarte');
  const { sub } = await app.store.subscribe(person.id, 'email', 'hermano@ejemplo.com');
  await app.store.verifySubscription(sub.verify_token);
  sg.received.length = 0;

  const fd = new FormData();
  fd.set('name', 'Rosa Elena Duarte');
  fd.set('location', 'Barrio Centro');
  fd.set('department', 'Antioquia');
  fd.set('contact_phone', '300 111 2222');
  fd.append('photos', new File([Buffer.from('foto')], 'f.jpg', { type: 'image/jpeg' }));
  const res = await fetch(`${app.base}/report`, { method: 'POST', body: fd, redirect: 'manual' });
  assert.equal(res.status, 303, 'el reporte se guarda y redirige, igual que siempre');

  assert.equal(sg.received.length, 1, 'el suscriptor existente debe enterarse de este reporte también');
  assert.match(sg.received[0].body.content[0].value, /DESAPARECID/i);

  delete process.env.NOTIFY_MODE;
});

// A web reporter typing their own phone/email into the form must not get their
// own report echoed back just because they happen to already be subscribed
// under that same address — same courtesy the WhatsApp bot already has via
// skipAddress.
test('POST /report does not echo the update back to the reporter if they are also a subscriber', async (t) => {
  const sg = await fakeSendgrid();
  const app = await startApp();
  t.after(() => {
    sg.server.close();
    app.server.close();
    delete process.env.SENDGRID_API_KEY;
    delete process.env.SENDGRID_API_BASE;
    delete process.env.NOTIFY_MODE;
  });
  process.env.SENDGRID_API_KEY = 'test-key';
  process.env.SENDGRID_API_BASE = sg.base;
  process.env.NOTIFY_MODE = 'direct';

  const { person } = await app.store.findOrCreatePerson('Iván Mauricio Salas');
  const { sub } = await app.store.subscribe(person.id, 'email', 'reportante@ejemplo.com');
  await app.store.verifySubscription(sub.verify_token);
  sg.received.length = 0;

  const fd = new FormData();
  fd.set('name', 'Iván Mauricio Salas');
  fd.set('location', 'Barrio Centro');
  fd.set('department', 'Antioquia');
  // Same address as the subscription, on purpose, and mixed case — the store
  // lowercases email on subscribe, so the skip has to match case-insensitively.
  fd.set('contact_email', 'Reportante@Ejemplo.com');
  fd.append('photos', new File([Buffer.from('foto')], 'f.jpg', { type: 'image/jpeg' }));
  await fetch(`${app.base}/report`, { method: 'POST', body: fd, redirect: 'manual' });

  assert.equal(sg.received.length, 0, 'no debe recibir su propio reporte de vuelta');
});

// The same self-echo guard, but for a WhatsApp subscriber — the channel the
// bot already protects via skipAddress. A web report typing that same number
// as its contact_phone must not echo back to it either.
//
// Trade-off worth naming: this skip matches by exact address, with no proof
// that the person filing THIS report is the same person who owns that
// address — a household sharing one WhatsApp number could have one member
// report while another is the actual subscriber, and that subscriber would
// miss this one notification. Same shape of trade-off the bot already accepts
// for skipAddress; not something this test changes.
test('POST /report does not echo the update back to a WhatsApp subscriber sharing the contact_phone', async (t) => {
  const wa = await fakeWhatsApp();
  const app = await startApp();
  t.after(() => {
    wa.stop();
    app.server.close();
    delete process.env.NOTIFY_MODE;
  });
  process.env.NOTIFY_MODE = 'direct';

  const { person } = await app.store.findOrCreatePerson('Fabián Torres Lemus');
  // Whatsapp subscriptions auto-verify (the bot proves ownership by which
  // number sent the message); subscribing straight through the store is the
  // equivalent of the bot having already done that.
  await app.store.subscribe(person.id, 'whatsapp', '573145556677');
  wa.received.length = 0;

  const fd = new FormData();
  fd.set('name', 'Fabián Torres Lemus');
  fd.set('location', 'Barrio Centro');
  fd.set('department', 'Antioquia');
  fd.set('contact_phone', '573145556677');
  fd.append('photos', new File([Buffer.from('foto')], 'f.jpg', { type: 'image/jpeg' }));
  await fetch(`${app.base}/report`, { method: 'POST', body: fd, redirect: 'manual' });

  assert.equal(wa.received.length, 0, 'no debe recibir su propio reporte de vuelta por WhatsApp');

  // Control: a DIFFERENT subscriber on a different number must still get it.
  await app.store.subscribe(person.id, 'whatsapp', '573200001111');
  wa.received.length = 0;
  const fd2 = new FormData();
  fd2.set('name', 'Fabián Torres Lemus');
  fd2.set('location', 'Barrio Centro');
  fd2.set('department', 'Antioquia');
  fd2.set('message', 'Fue visto de nuevo cerca del parque');
  fd2.set('contact_phone', '573145556677');
  fd2.append('photos', new File([Buffer.from('foto')], 'f2.jpg', { type: 'image/jpeg' }));
  await fetch(`${app.base}/report`, { method: 'POST', body: fd2, redirect: 'manual' });

  assert.equal(wa.received.length, 1, 'un suscriptor distinto sí debe recibir el aviso');
});

test('a SendGrid rejection is surfaced, not swallowed', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ errors: [{ message: 'The from address does not match a verified Sender Identity.' }] }));
  });
  await new Promise((r) => server.listen(0, r));
  t.after(() => {
    server.close();
    delete process.env.SENDGRID_API_KEY;
    delete process.env.SENDGRID_API_BASE;
  });
  process.env.SENDGRID_API_KEY = 'test-key';
  process.env.SENDGRID_API_BASE = `http://127.0.0.1:${server.address().port}`;

  const { sendEmail } = require('../src/notify');
  const result = await sendEmail('x@ejemplo.com', 'asunto', 'cuerpo');
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.match(result.error, /verified Sender Identity/);
});

test('a failed verification email is shown on screen, never silently swallowed', async (t) => {
  // SendGrid rejecting the sender is the classic production failure.
  const sg = http.createServer((req, res) => {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ errors: [{ message: 'The from address does not match a verified Sender Identity.' }] }));
  });
  await new Promise((r) => sg.listen(0, r));
  const app = await startApp();
  t.after(() => {
    sg.close();
    app.server.close();
    delete process.env.SENDGRID_API_KEY;
    delete process.env.SENDGRID_API_BASE;
  });
  process.env.SENDGRID_API_KEY = 'SG.test-key';
  process.env.SENDGRID_API_BASE = `http://127.0.0.1:${sg.address().port}`;

  const fd = new FormData();
  fd.set('photo', new File([Buffer.from('foto')], 'r.jpg', { type: 'image/jpeg' }));
  fd.set('email', 'nadie@ejemplo.com');
  const res = await fetch(`${app.base}/rescate`, { method: 'POST', body: fd });
  // The rescue result still renders; the failure is visible in the server log
  // and the subscription simply stays unverified, so no alert can be promised.
  assert.equal(res.status, 200);
  const [sub] = await app.store.getSubscriptions(
    (await app.store.searchPeople('Persona rescatada'))[0].id
  );
  assert.equal(sub.verified, 0, 'sin correo entregado, la suscripción queda sin verificar');
});

test('diag gives an actionable verdict for each failure mode', async (t) => {
  const app = await startApp();
  t.after(() => {
    app.server.close();
    delete process.env.SENDGRID_API_KEY;
    delete process.env.SENDGRID_API_BASE;
  });

  // No key configured at all
  delete process.env.SENDGRID_API_KEY;
  const noKey = await (await fetch(`${app.base}/api/diag`)).json();
  assert.equal(noKey.email.sendgrid_key_present, false);
  assert.equal(noKey.runtime.fetch_available, true);

  // Key present but SendGrid rejects the sender
  const sg = http.createServer((req, res) => {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ errors: [{ message: 'The from address does not match a verified Sender Identity.' }] }));
  });
  await new Promise((r) => sg.listen(0, r));
  t.after(() => sg.close());
  process.env.SENDGRID_API_KEY = 'SG.abc';
  process.env.SENDGRID_API_BASE = `http://127.0.0.1:${sg.address().port}`;

  const app2 = await startApp();
  t.after(() => app2.server.close());
  // The test send lives on POST /api/diag/test-email now — GET /api/diag is
  // side-effect-free (see security/diag-reindex-hardening).
  const diag = await (
    await fetch(`${app2.base}/api/diag/test-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'x@ejemplo.com' })
    })
  ).json();
  assert.equal(diag.email.test.ok, false);
  assert.equal(diag.email.test.status, 403);
  assert.match(diag.email.veredicto, /no está verificado|Sender Authentication/);
});

test('transactional emails disable click tracking so links are not rewritten', async (t) => {
  const sg = await fakeSendgrid();
  const app = await startApp();
  t.after(() => {
    sg.server.close();
    app.server.close();
    delete process.env.SENDGRID_API_KEY;
    delete process.env.SENDGRID_API_BASE;
  });
  process.env.SENDGRID_API_KEY = 'SG.test-key';
  process.env.SENDGRID_API_BASE = sg.base;

  const fd = new FormData();
  fd.set('photo', new File([Buffer.from('foto')], 'r.jpg', { type: 'image/jpeg' }));
  fd.set('email', 'beatriz@ejemplo.com');
  await fetch(`${app.base}/rescate`, { method: 'POST', body: fd });

  assert.equal(sg.received.length, 1);
  const body = sg.received[0].body;
  // SendGrid's tracking domain returned 403 in production, which broke every
  // verification link. Links must go straight to encontrados.co.
  assert.equal(body.tracking_settings.click_tracking.enable, false);
  assert.equal(body.tracking_settings.click_tracking.enable_text, false);
  assert.equal(body.tracking_settings.open_tracking.enable, false);
  assert.match(body.content[0].value, /https?:\/\/[^\s]*\/verify\?token=/);
});
