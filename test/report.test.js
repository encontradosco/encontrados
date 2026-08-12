// GET|POST /api/report/send — el reporte de operación por correo (#116, parte 2).
//
// Lo que estos tests protegen: que el correo lleve SOLO cifras agregadas (ni
// un nombre, ni un contacto, ni un enlace a una ficha), que los rechazos y
// fallos vayan ANTES que cualquier otra métrica, que sin CRON_SECRET el
// endpoint quede cerrado (503) y con credencial equivocada rechace (401), que
// sin REPORT_EMAILS no salga nada y quede dicho, y que con el matcher apagado
// el reporte salga igual declarándolo — un correo que no llega porque el
// matcher está caído esconde justo la noticia que había que dar.
const test = require('node:test');
const assert = require('node:assert');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { nullMatcher } = require('../src/faces');
const { fakeSendgrid } = require('./helpers');

// Matcher de mentiras con respuestas fijas por face_id (el patrón de
// test/match-stats.test.js).
function fakeMatcher(answers) {
  return {
    enabled: true,
    status: 'activo (fake)',
    async indexFace() {
      return { faceId: null, geometry: null };
    },
    async detectFace() {
      return null;
    },
    async searchByImage() {
      return [];
    },
    async searchByFaceId(faceId) {
      const a = answers[faceId];
      if (typeof a === 'function') return a();
      return a || [];
    }
  };
}

async function startApp(matcher) {
  const app = await createApp(await createSqliteAdapter(':memory:'), matcher);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}`, store: app.locals.store };
}

// Una persona con su reporte (contacto y reportante SINTÉTICOS incluidos, para
// poder afirmar que NO viajan en el correo) y su foto indexada; o, con
// kind: 'query', el ancla de una consulta de rescatista.
async function seedPerson(store, { name, kind, faceId, contact, reporter }) {
  const { person } = await store.findOrCreatePerson(name);
  const update = await store.addUpdate(person.id, {
    status: 'missing',
    source: 'web',
    contact,
    reporter
  });
  const photo = await store.addPhoto({
    personId: person.id,
    kind,
    updateId: kind === 'report' ? update.id : undefined,
    content: Buffer.alloc(0),
    contentType: 'image/jpeg'
  });
  if (faceId) await store.setPhotoFaceId(photo.id, faceId);
  return person;
}

function cleanupEnv() {
  delete process.env.CRON_SECRET;
  delete process.env.REPORT_EMAILS;
}

test('el reporte sale a todos los buzones, con los fallos primero y solo cifras', async (t) => {
  const sg = await fakeSendgrid();
  const matcher = fakeMatcher({
    'cara-consulta-1': [{ faceId: 'cara-reporte-1', similarity: 97 }]
  });
  const { server, base, store } = await startApp(matcher);
  process.env.CRON_SECRET = 'secreto-cron-prueba';
  process.env.REPORT_EMAILS = 'operadora@example.com, operador2@example.com';
  t.after(() => {
    server.close();
    sg.stop();
    cleanupEnv();
  });

  await seedPerson(store, {
    name: 'Amapola Sintetica Flores',
    kind: 'report',
    faceId: 'cara-reporte-1',
    contact: '3009998877 familiar@example.com',
    reporter: 'Reportante Sintetico'
  });
  await seedPerson(store, { name: 'Consulta Prueba Gaviota', kind: 'query', faceId: 'cara-consulta-1' });
  // Una foto sin indexar: tiene que aparecer como pendiente en los fallos.
  await seedPerson(store, { name: 'Nadie Indexado Cero', kind: 'query', faceId: null });

  const res = await fetch(`${base}/api/report/send`, {
    headers: { Authorization: 'Bearer secreto-cron-prueba' }
  });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.sent, 2);
  assert.equal(out.failed, 0);

  const mails = sg.received.filter((r) => r.url === '/v3/mail/send');
  assert.equal(mails.length, 2, 'un correo por buzón de REPORT_EMAILS');
  const destinos = mails.map((m) => m.body.personalizations[0].to[0].email).sort();
  assert.deepEqual(destinos, ['operador2@example.com', 'operadora@example.com']);

  const text = mails[0].body.content[0].value;
  assert.match(mails[0].body.subject, /Reporte de operación/);
  // Siempre acumulado, nunca solo el delta — y dicho en el propio correo.
  assert.match(text, /ACUMULADO/);
  // La primera métrica son los rechazos y fallos, no las llegadas.
  assert.ok(
    text.indexOf('LO QUE FALLA') < text.indexOf('EL CRUCE FACIAL') &&
      text.indexOf('EL CRUCE FACIAL') < text.indexOf('EL REGISTRO'),
    'los fallos van antes que cualquier otra cifra'
  );
  assert.match(text, /fallaron al recomputar el cruce: 0 de 1/);
  assert.match(text, /SIN firma facial[^:]*: 1/);
  assert.match(text, /coinciden con al menos un reporte: 1/);
  assert.match(text, /Personas: 3/);

  // La garantía de privacidad del correo: agregados y nada más. Ni nombres,
  // ni contactos, ni reportantes, ni enlaces a fichas, ni face_ids.
  for (const leak of [
    'Amapola',
    'Gaviota',
    'Nadie Indexado',
    'Sintetico',
    '3009998877',
    'familiar@example.com',
    '/person/',
    'cara-'
  ]) {
    assert.ok(!text.includes(leak), `el correo no debe contener "${leak}":\n${text}`);
  }
});

test('sin CRON_SECRET responde 503 y con credencial equivocada 401 — nunca manda nada', async (t) => {
  const sg = await fakeSendgrid();
  const { server, base } = await startApp(fakeMatcher({}));
  t.after(() => {
    server.close();
    sg.stop();
    cleanupEnv();
  });

  delete process.env.CRON_SECRET;
  assert.equal((await fetch(`${base}/api/report/send`)).status, 503);

  process.env.CRON_SECRET = 'secreto-cron-prueba';
  assert.equal((await fetch(`${base}/api/report/send`)).status, 401);
  assert.equal(
    (
      await fetch(`${base}/api/report/send`, {
        headers: { Authorization: 'Bearer llave-equivocada' }
      })
    ).status,
    401
  );
  assert.equal(sg.received.filter((r) => r.url === '/v3/mail/send').length, 0);
});

test('sin REPORT_EMAILS no sale ningún correo y la respuesta lo dice', async (t) => {
  const sg = await fakeSendgrid();
  const { server, base } = await startApp(fakeMatcher({}));
  process.env.CRON_SECRET = 'secreto-cron-prueba';
  delete process.env.REPORT_EMAILS;
  t.after(() => {
    server.close();
    sg.stop();
    cleanupEnv();
  });

  const res = await fetch(`${base}/api/report/send`, {
    headers: { Authorization: 'Bearer secreto-cron-prueba' }
  });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.sent, 0);
  assert.match(out.skipped, /REPORT_EMAILS/);
  assert.equal(sg.received.filter((r) => r.url === '/v3/mail/send').length, 0);
});

test('con el matcher apagado el reporte sale igual, declarándolo', async (t) => {
  const sg = await fakeSendgrid();
  const { server, base } = await startApp(nullMatcher);
  process.env.CRON_SECRET = 'secreto-cron-prueba';
  process.env.REPORT_EMAILS = 'operadora@example.com';
  t.after(() => {
    server.close();
    sg.stop();
    cleanupEnv();
  });

  const res = await fetch(`${base}/api/report/send`, {
    headers: { Authorization: 'Bearer secreto-cron-prueba' }
  });
  assert.equal(res.status, 200);

  const mails = sg.received.filter((r) => r.url === '/v3/mail/send');
  assert.equal(mails.length, 1);
  const text = mails[0].body.content[0].value;
  assert.match(text, /matcher facial no está disponible/);
  assert.match(text, /EL REGISTRO/);
});
