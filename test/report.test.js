// GET|POST /api/report/send — el reporte operativo recurrente (#116, PR 2).
//
// Lo que estos tests protegen: que el HTML traiga las secciones aprobadas por
// @ni500, que sin REPORT_RECIPIENTS el envío se niegue RUIDOSAMENTE (nunca en
// silencio), que la ruta exija credencial (API key o CRON_SECRET), que el
// correo no filtre nada identificable (mismo estándar que match-stats.test.js),
// y que con el reconocimiento facial apagado el reporte se siga mandando —
// degradado, nunca callado.
const test = require('node:test');
const assert = require('node:assert');
const env = require('../src/env');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { nullMatcher } = require('../src/faces');
const { fakeSendgrid } = require('./helpers');

function fakeMatcher(answers = {}) {
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

async function seedPerson(store, { name, kind, faceId }) {
  const { person } = await store.findOrCreatePerson(name);
  const update = await store.addUpdate(person.id, { status: 'missing', source: 'web', contact: '3001234567' });
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
  delete process.env.REPORT_RECIPIENTS;
  delete process.env.CRON_SECRET;
  env.API_KEY = '';
}

test('trae las secciones aprobadas, con las cifras vivas de la corrida', async (t) => {
  const sg = await fakeSendgrid();
  const matcher = fakeMatcher({
    'cara-consulta-1': [{ faceId: 'cara-reporte-1', similarity: 97 }]
  });
  const { server, base, store } = await startApp(matcher);
  t.after(() => {
    server.close();
    sg.stop();
    cleanupEnv();
  });
  process.env.REPORT_RECIPIENTS = 'operador1@ejemplo.com';
  env.API_KEY = 'secreta-de-prueba';

  await seedPerson(store, { name: 'Amapola Sintetica Flores', kind: 'report', faceId: 'cara-reporte-1' });
  await seedPerson(store, { name: 'Consulta Prueba Gaviota', kind: 'query', faceId: 'cara-consulta-1' });

  const res = await fetch(`${base}/api/report/send`, {
    headers: { Authorization: 'Bearer secreta-de-prueba' }
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.sent, 1);
  assert.equal(body.failed, 0);
  assert.equal(body.stats_available, true);

  assert.equal(sg.received.length, 1);
  const mail = sg.received[0];
  assert.equal(mail.body.personalizations[0].to[0].email, 'operador1@ejemplo.com');
  assert.match(mail.body.subject, /^\[encontrados\] Reporte operativo — \d+ \w+, \d{2}:\d{2} · 1 persona con coincidencia$/);

  const html = mail.body.content.find((c) => c.type === 'text/html').value;
  for (const section of [
    '¿Cómo se calcula esto?',
    '1 · ¿Podemos confiar en los números de abajo?',
    '2 · Coincidencias (el embudo, acumulado)',
    '3 · Lo que todavía NO podemos medir',
    '4 · La base en general'
  ]) {
    assert.ok(html.includes(section), `falta la sección "${section}"`);
  }
  // Las cifras del embudo, ya con los campos corregidos (personas del lado
  // reportado, no fotos de quien busca).
  assert.match(html, />1<\/td>/); // reported_people_indexed y reported_people_matched, ambos 1
  assert.ok(html.includes('Generado automáticamente 3×/día · Destinos por variable de entorno · Plan: #116'));
});

test('sin REPORT_RECIPIENTS el envío se niega RUIDOSAMENTE, nunca en silencio', async (t) => {
  const sg = await fakeSendgrid();
  const { server, base } = await startApp(fakeMatcher({}));
  t.after(() => {
    server.close();
    sg.stop();
    cleanupEnv();
  });
  env.API_KEY = 'secreta-de-prueba';

  const res = await fetch(`${base}/api/report/send`, {
    headers: { Authorization: 'Bearer secreta-de-prueba' }
  });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /REPORT_RECIPIENTS no configurada/);
  assert.equal(sg.received.length, 0, 'no debió intentar mandar nada sin destinos');
});

test('la ruta exige credencial — API key o CRON_SECRET, nunca abierta', async (t) => {
  const sg = await fakeSendgrid();
  const { server, base } = await startApp(fakeMatcher({}));
  t.after(() => {
    server.close();
    sg.stop();
    cleanupEnv();
  });
  process.env.REPORT_RECIPIENTS = 'operador1@ejemplo.com';
  env.API_KEY = 'llave-de-api';
  process.env.CRON_SECRET = 'secreto-del-cron';

  const noAuth = await fetch(`${base}/api/report/send`);
  assert.equal(noAuth.status, 401);

  const wrongAuth = await fetch(`${base}/api/report/send`, {
    headers: { Authorization: 'Bearer lo-que-sea' }
  });
  assert.equal(wrongAuth.status, 401);

  const apiKeyAuth = await fetch(`${base}/api/report/send`, {
    headers: { Authorization: 'Bearer llave-de-api' }
  });
  assert.equal(apiKeyAuth.status, 200);

  const cronAuth = await fetch(`${base}/api/report/send`, {
    headers: { Authorization: 'Bearer secreto-del-cron' }
  });
  assert.equal(cronAuth.status, 200);
});

test('la ruta falla CERRADA sin API_KEY ni CRON_SECRET configurados (a diferencia de las lecturas normales)', async (t) => {
  const { server, base } = await startApp(fakeMatcher({}));
  t.after(() => {
    server.close();
    cleanupEnv();
  });
  process.env.REPORT_RECIPIENTS = 'operador1@ejemplo.com';
  // Ni env.API_KEY ni process.env.CRON_SECRET están seteados acá.

  const res = await fetch(`${base}/api/report/send`);
  assert.equal(res.status, 401);
});

test('el correo no filtra nombres, contactos ni ids — solo cifras agregadas', async (t) => {
  const sg = await fakeSendgrid();
  const matcher = fakeMatcher({
    'cara-consulta-1': [{ faceId: 'cara-reporte-1', similarity: 97 }]
  });
  const { server, base, store } = await startApp(matcher);
  t.after(() => {
    server.close();
    sg.stop();
    cleanupEnv();
  });
  process.env.REPORT_RECIPIENTS = 'operador1@ejemplo.com';
  env.API_KEY = 'secreta-de-prueba';

  await seedPerson(store, { name: 'Amapola Sintetica Flores', kind: 'report', faceId: 'cara-reporte-1' });
  await seedPerson(store, { name: 'Consulta Prueba Gaviota', kind: 'query', faceId: 'cara-consulta-1' });

  const res = await fetch(`${base}/api/report/send`, {
    headers: { Authorization: 'Bearer secreta-de-prueba' }
  });
  assert.equal(res.status, 200);

  const mail = sg.received[0];
  const raw = JSON.stringify(mail.body);
  for (const leak of ['Amapola', 'Gaviota', 'cara-', 'person_id', 'face_id', '3001234567']) {
    assert.ok(!raw.includes(leak), `el correo no debe contener "${leak}"`);
  }
});

test('con el matcher apagado, el reporte se manda igual — degradado, no callado', async (t) => {
  const sg = await fakeSendgrid();
  const { server, base } = await startApp(nullMatcher);
  t.after(() => {
    server.close();
    sg.stop();
    cleanupEnv();
  });
  process.env.REPORT_RECIPIENTS = 'operador1@ejemplo.com';
  env.API_KEY = 'secreta-de-prueba';

  const res = await fetch(`${base}/api/report/send`, {
    headers: { Authorization: 'Bearer secreta-de-prueba' }
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.stats_available, false);

  assert.equal(sg.received.length, 1);
  const mail = sg.received[0];
  assert.match(mail.body.subject, /reconocimiento facial no disponible/);
  const html = mail.body.content.find((c) => c.type === 'text/html').value;
  assert.ok(html.includes('El reconocimiento facial no está disponible en esta corrida'));
  // La tabla 4 (base general) no depende de Rekognition y sigue viva.
  assert.ok(html.includes('4 · La base en general'));
});

test('REPORT_RECIPIENTS con varios destinos manda un correo por cada uno, sin exponerlos entre sí', async (t) => {
  const sg = await fakeSendgrid();
  const { server, base } = await startApp(fakeMatcher({}));
  t.after(() => {
    server.close();
    sg.stop();
    cleanupEnv();
  });
  process.env.REPORT_RECIPIENTS = ' operador1@ejemplo.com, operador2@ejemplo.com ,operador3@ejemplo.com';
  env.API_KEY = 'secreta-de-prueba';

  const res = await fetch(`${base}/api/report/send`, {
    headers: { Authorization: 'Bearer secreta-de-prueba' }
  });
  const body = await res.json();
  assert.equal(body.recipients, 3);
  assert.equal(body.sent, 3);

  assert.equal(sg.received.length, 3);
  const tos = sg.received.map((m) => m.body.personalizations[0].to.map((t) => t.email));
  for (const to of tos) {
    assert.equal(to.length, 1, 'cada correo debe ir a un solo destinatario, nunca a la lista completa');
  }
  const addresses = tos.flat().sort();
  assert.deepEqual(addresses, ['operador1@ejemplo.com', 'operador2@ejemplo.com', 'operador3@ejemplo.com']);
});
