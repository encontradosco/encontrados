const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { nullMatcher } = require('../src/faces');

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

  const { person } = await app.store.findOrCreatePerson('Marcela Ospina');
  const res = await fetch(`${app.base}/person/${person.id}/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'familia@ejemplo.com' }),
    redirect: 'manual'
  });
  assert.equal(res.status, 303);

  // The send must already have happened — no floating promise, because a
  // serverless function is frozen the moment it responds.
  assert.equal(sg.received.length, 1, 'no se envió el correo de verificación');
  const mail = sg.received[0];
  assert.equal(mail.auth, 'Bearer test-key');
  assert.equal(mail.body.personalizations[0].to[0].email, 'familia@ejemplo.com');
  assert.equal(mail.body.from.email, 'a@torrenegra.com');
  assert.match(mail.body.content[0].value, /\/verify\?token=/);
});

test('update alerts reach verified subscribers before the response returns', async (t) => {
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
