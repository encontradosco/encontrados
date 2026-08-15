// GET /api/match-stats — el recuento histórico de matches (#116, parte 1).
//
// Lo que estos tests protegen: que el endpoint devuelva SOLO cifras agregadas
// (ni un nombre, ni un contacto, ni un id de persona), que vaya detrás de la
// API key, y que un fallo parcial de Rekognition se declare en `failed` en vez
// de esconderse dentro de un total que parece completo.
const test = require('node:test');
const assert = require('node:assert');
const env = require('../src/env');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { nullMatcher } = require('../src/faces');

// Matcher de mentiras con respuestas fijas por face_id. `answers` es un mapa
// face_id -> [{ faceId, similarity }]; un valor que sea una función se invoca
// (para simular un fallo de Rekognition con throw).
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

// Una persona con su reporte y su foto de reporte indexada; o, con
// kind: 'query', el ancla de una consulta de rescatista.
async function seedPerson(store, { name, kind, faceId }) {
  const { person } = await store.findOrCreatePerson(name);
  const update = await store.addUpdate(person.id, { status: 'missing', source: 'web' });
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

test('cuenta el cruce query→report, los duplicados de consulta y las firmas colgadas — solo cifras', async (t) => {
  const matcher = fakeMatcher({
    // Consulta 1: coincide con un reporte real y con una firma fantasma que ya
    // no tiene foto en la base (persona borrada, ver #71).
    'cara-consulta-1': [
      { faceId: 'cara-reporte-1', similarity: 97 },
      { faceId: 'cara-fantasma', similarity: 91 }
    ],
    // Consulta 2: solo coincide con otra consulta (la misma cara, dos veces).
    'cara-consulta-2': [{ faceId: 'cara-consulta-1', similarity: 95 }]
  });
  const { server, base, store } = await startApp(matcher);
  t.after(() => server.close());

  await seedPerson(store, { name: 'Amapola Sintetica Flores', kind: 'report', faceId: 'cara-reporte-1' });
  await seedPerson(store, { name: 'Bernardo Ficticio Rios', kind: 'report', faceId: 'cara-reporte-2' });
  await seedPerson(store, { name: 'Consulta Prueba Gaviota', kind: 'query', faceId: 'cara-consulta-1' });
  await seedPerson(store, { name: 'Anclaje Ejemplo Turpial', kind: 'query', faceId: 'cara-consulta-2' });
  // Una foto sin indexar no entra al recuento por ningún lado.
  await seedPerson(store, { name: 'Nadie Indexado Cero', kind: 'query', faceId: null });

  const res = await fetch(`${base}/api/match-stats`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.deepEqual(body.indexed, { query: 2, report: 2 });
  assert.equal(body.searched, 2);
  assert.equal(body.failed, 0);
  assert.equal(body.query_photos_with_report_match, 1);
  assert.equal(body.query_photos_with_query_match, 1);
  assert.equal(body.reported_people_matched, 1);
  assert.equal(body.query_people_matched, 1);
  assert.equal(body.dangling_face_matches, 1);

  // La garantía de privacidad del endpoint: agregados y nada más. Ni nombres,
  // ni ids de persona, ni face_ids pueden viajar en la respuesta.
  const raw = JSON.stringify(body);
  for (const leak of ['Amapola', 'Bernardo', 'Gaviota', 'Turpial', 'cara-', 'person_id', 'face_id']) {
    assert.ok(!raw.includes(leak), `la respuesta no debe contener "${leak}": ${raw}`);
  }
});

// Campos que consume el reporte por correo (#116, PR 2): el universo tiene que
// contar PERSONAS reportadas, no fotos de quien busca, y el total de
// coincidencias tiene que poder superar el conteo de personas distintas
// cuando una misma persona aparece en más de una foto.
test('reported_people_indexed cuenta personas (no fotos), y report_matches_total suma cada golpe', async (t) => {
  const matcher = fakeMatcher({
    // Dos fotos de consulta golpean, cada una, contra las DOS fotos de
    // reporte de la MISMA persona: 1 persona, 2 fotos de reporte, 4 golpes.
    'cara-consulta-1': [
      { faceId: 'cara-reporte-1a', similarity: 96 },
      { faceId: 'cara-reporte-1b', similarity: 90 }
    ],
    'cara-consulta-2': [
      { faceId: 'cara-reporte-1a', similarity: 93 },
      { faceId: 'cara-reporte-1b', similarity: 92 }
    ]
  });
  const { server, base, store } = await startApp(matcher);
  t.after(() => server.close());

  const { person } = await store.findOrCreatePerson('Persona Con Dos Fotos');
  const update = await store.addUpdate(person.id, { status: 'missing', source: 'web' });
  for (const faceId of ['cara-reporte-1a', 'cara-reporte-1b']) {
    const photo = await store.addPhoto({
      personId: person.id,
      kind: 'report',
      updateId: update.id,
      content: Buffer.alloc(0),
      contentType: 'image/jpeg'
    });
    await store.setPhotoFaceId(photo.id, faceId);
  }
  await seedPerson(store, { name: 'Consulta Uno', kind: 'query', faceId: 'cara-consulta-1' });
  await seedPerson(store, { name: 'Consulta Dos', kind: 'query', faceId: 'cara-consulta-2' });

  const body = await (await fetch(`${base}/api/match-stats`)).json();
  assert.equal(body.reported_people_indexed, 1, 'una sola persona, aunque tenga dos fotos indexadas');
  assert.equal(body.reported_people_matched, 1);
  assert.equal(body.report_matches_total, 4, 'cada golpe individual cuenta, sin deduplicar por persona ni por foto');
});

test('un fallo de Rekognition se declara en failed, sin tumbar el resto del recuento', async (t) => {
  const matcher = fakeMatcher({
    'cara-consulta-1': [{ faceId: 'cara-reporte-1', similarity: 96 }],
    'cara-consulta-2': () => {
      throw new Error('ThrottlingException');
    }
  });
  const { server, base, store } = await startApp(matcher);
  t.after(() => server.close());

  await seedPerson(store, { name: 'Amapola Sintetica Flores', kind: 'report', faceId: 'cara-reporte-1' });
  await seedPerson(store, { name: 'Consulta Prueba Gaviota', kind: 'query', faceId: 'cara-consulta-1' });
  await seedPerson(store, { name: 'Anclaje Ejemplo Turpial', kind: 'query', faceId: 'cara-consulta-2' });

  const body = await (await fetch(`${base}/api/match-stats`)).json();
  assert.equal(body.searched, 1);
  assert.equal(body.failed, 1, 'el fallo tiene que quedar declarado — un total que calla sus huecos miente');
  assert.equal(body.query_photos_with_report_match, 1);
});

test('GET /api/match-stats exige la API key cuando hay una configurada', async (t) => {
  const { server, base } = await startApp(fakeMatcher({}));
  t.after(() => {
    server.close();
    env.API_KEY = '';
  });
  env.API_KEY = 'secreta-de-prueba';

  const noAuth = await fetch(`${base}/api/match-stats`);
  assert.equal(noAuth.status, 401);

  const wrongAuth = await fetch(`${base}/api/match-stats`, {
    headers: { Authorization: 'Bearer llave-equivocada' }
  });
  assert.equal(wrongAuth.status, 401);

  const okAuth = await fetch(`${base}/api/match-stats`, {
    headers: { Authorization: 'Bearer secreta-de-prueba' }
  });
  assert.equal(okAuth.status, 200);
});

test('con el matcher apagado responde 503, no un cero que parezca un dato', async (t) => {
  const { server, base } = await startApp(nullMatcher);
  t.after(() => server.close());

  const res = await fetch(`${base}/api/match-stats`);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.match(body.error, /matcher facial no está disponible/);
});
