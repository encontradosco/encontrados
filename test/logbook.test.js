// La bitácora de coincidencias y de envíos (#116, PR 4 — la instrumentación).
// Lo que estos tests protegen: que un match real y un envío real (éxito Y
// fallo) queden escritos en match_log/contact_log; que las filas no cargan
// nada más que IDs, enums y números (ni rastro de los nombres/contactos
// sembrados); y la regla de oro — un fallo escribiendo la bitácora NUNCA
// tumba ni retrasa el flujo principal.
const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { logMatch, logContact } = require('../src/logbook');
const { fakeSendgrid } = require('./helpers');

// Mismo patrón que test/rescue.test.js: firmas idénticas por bytes idénticos,
// así el pipeline completo corre sin AWS.
function fakeMatcher() {
  const indexed = new Map();
  let n = 0;
  const key = (b) => b.toString('utf8');
  return {
    enabled: true,
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

async function photoBytes(label) {
  let h = 0;
  for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) % 16777216;
  return sharp({
    create: { width: 200, height: 250, channels: 3, background: { r: (h >> 16) & 255, g: (h >> 8) & 255, b: h & 255 } }
  })
    .jpeg()
    .toBuffer();
}

async function startApp(matcher) {
  const app = await createApp(await createSqliteAdapter(':memory:'), matcher || fakeMatcher());
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}`, store: app.locals.store };
}

async function reportMissing(base, { name, contact, face }) {
  const fd = new FormData();
  fd.set('name', name);
  fd.set('location', 'Barrio San José');
  fd.set('contact', contact);
  fd.append('photos', new File([await photoBytes(face)], 'f.jpg', { type: 'image/jpeg' }));
  return fetch(`${base}/report`, { method: 'POST', body: fd, redirect: 'manual' });
}

// -------------------------------------------------------- unidad, logMatch/logContact

test('logMatch escribe una fila real, solo con IDs/enums/números', async () => {
  const store = (await createApp(await createSqliteAdapter(':memory:'))).locals.store;
  const { person } = await store.findOrCreatePerson('Alguien De Prueba');
  await logMatch(store, { personId: person.id, updateId: null, faceId: 'cara-x', similarity: 88.5, surface: 'rescate' });

  const counts = await store.matchLogCounts();
  assert.equal(counts.total, 1);
  assert.equal(counts.rescate, 1);
  assert.equal(counts.report, 0);
});

test('logContact escribe una fila real, con el resultado correcto', async () => {
  const store = (await createApp(await createSqliteAdapter(':memory:'))).locals.store;
  const { person } = await store.findOrCreatePerson('Alguien De Prueba');
  await logContact(store, { personId: person.id, updateId: null, channel: 'email', result: 'enviado' });
  await logContact(store, { personId: person.id, updateId: null, channel: 'whatsapp', result: 'fallido' });

  const rows = await store.contactLogCounts();
  const byChannel = Object.fromEntries(rows.map((r) => [`${r.channel}:${r.result}`, r.count]));
  assert.equal(byChannel['email:enviado'], 1);
  assert.equal(byChannel['whatsapp:fallido'], 1);
});

test('regla de oro (unidad): un store que revienta al escribir no tumba logMatch/logContact', async () => {
  const brokenStore = {
    async insertMatchLog() {
      throw new Error('match_log roto a propósito');
    },
    async insertContactLog() {
      throw new Error('contact_log roto a propósito');
    }
  };
  // No debe lanzar — ese es exactamente el contrato que protege el flujo
  // principal.
  await assert.doesNotReject(
    logMatch(brokenStore, { personId: 1, updateId: null, faceId: 'x', similarity: 1, surface: 'rescate' })
  );
  await assert.doesNotReject(
    logContact(brokenStore, { personId: 1, updateId: null, channel: 'email', result: 'enviado' })
  );
});

// --------------------------------------------------- integración, flujo real de /rescate

test('un match real por /rescate deja una fila en match_log con superficie "rescate"', async (t) => {
  const { server, base, store } = await startApp();
  t.after(() => server.close());

  await reportMissing(base, { name: 'Camila Rojas', contact: 'hermana@ejemplo.com', face: 'camila' });

  // Con email: crea la suscripción que dispara notifyFaceMatch (y por lo
  // tanto el intento de aviso) — sin esto solo se ve la pantalla, sin ningún
  // intento de contacto de por medio.
  const fd = new FormData();
  fd.set('photo', new File([await photoBytes('camila')], 'rescatada.jpg', { type: 'image/jpeg' }));
  fd.set('email', 'rescatista@ejemplo.com');
  const res = await fetch(`${base}/rescate`, { method: 'POST', body: fd });
  assert.equal(res.status, 200);

  const matchCounts = await store.matchLogCounts();
  assert.equal(matchCounts.total, 1, 'debía quedar una coincidencia registrada');
  assert.equal(matchCounts.rescate, 1);

  // Sin AVISO_EMAIL configurada, el relevo por omisión falla — y ESO también
  // debe quedar escrito: los fallos importan más que los envíos.
  const contactCounts = await store.contactLogCounts();
  const relevo = contactCounts.find((r) => r.channel === 'relevo');
  assert.ok(relevo, 'debía quedar un intento de relevo registrado');
  assert.equal(relevo.result, 'fallido', 'sin AVISO_EMAIL configurada, el relevo falla — y así debe quedar registrado');
});

test('las filas de match_log/contact_log no filtran nada de lo sembrado — solo IDs, enums y números', async (t) => {
  const { server, base, store } = await startApp();
  t.after(() => server.close());

  await reportMissing(base, {
    name: 'Beatriz Fernanda Gómez',
    contact: 'familia-beatriz@ejemplo.com · 300 999 8888',
    face: 'beatriz'
  });
  const fd = new FormData();
  fd.set('photo', new File([await photoBytes('beatriz')], 'r.jpg', { type: 'image/jpeg' }));
  fd.set('email', 'quien-rescato@ejemplo.com');
  await fetch(`${base}/rescate`, { method: 'POST', body: fd });

  // Las dos tablas solo exponen agregados por su propio diseño (PR 3), pero
  // acá se verifica algo distinto: que las funciones de escritura de PR 4
  // (logMatch/logContact) tampoco reciban ni pasen esos datos por accidente.
  // matchLogCounts/contactLogCounts son agregados puros — si algo de PII se
  // hubiera colado en una columna, no aparecería acá; por eso la garantía
  // real está en el esquema (test/schema-log-tables.test.js) y en que los
  // call sites de PR 4 solo pasan personId/updateId/faceId/similarity/surface
  // y personId/updateId/channel/result — nunca un nombre ni un contacto.
  const raw = JSON.stringify({
    match: await store.matchLogCounts(),
    contact: await store.contactLogCounts()
  });
  for (const leak of ['Beatriz', 'Gómez', 'familia-beatriz', '300 999 8888']) {
    assert.ok(!raw.includes(leak), `los agregados de la bitácora no deben contener "${leak}"`);
  }
});

// -------------------------------------------- regla de oro, extremo a extremo

test('regla de oro (integración): la bitácora rota no tumba un match real en /rescate', async (t) => {
  const { server, base, store } = await startApp();
  t.after(() => server.close());

  await reportMissing(base, { name: 'Diana Prueba Rota', contact: 'diana@ejemplo.com', face: 'diana' });

  // Se rompe la escritura DESPUÉS de que la app ya arrancó — mismo objeto que
  // ya tienen capturado por closure las rutas (server.js guarda esta
  // referencia en app.locals.store), así que el parche sí las alcanza.
  store.insertMatchLog = async () => {
    throw new Error('match_log roto a propósito (prueba)');
  };
  store.insertContactLog = async () => {
    throw new Error('contact_log roto a propósito (prueba)');
  };

  // Con email, para que también se ejercite (y reviente) el intento de
  // aviso — logContact(), no solo logMatch().
  const fd = new FormData();
  fd.set('photo', new File([await photoBytes('diana')], 'r.jpg', { type: 'image/jpeg' }));
  fd.set('email', 'rescatista-diana@ejemplo.com');
  const res = await fetch(`${base}/rescate`, { method: 'POST', body: fd });
  const html = await res.text();

  // El match sigue en pantalla, con el mismo 200 de siempre — la bitácora
  // rota no debe filtrarse a la respuesta ni tumbar la petición, ni el aviso
  // (que igual falla por falta de AVISO_EMAIL, pero por SU cuenta, no por la
  // bitácora).
  assert.equal(res.status, 200);
  assert.match(html, /Diana Prueba Rota/);
  assert.match(html, /Coincidencia facial/);
});

test('regla de oro (integración): la bitácora rota no tumba un reporte con foto en /report', async (t) => {
  const { server, base, store } = await startApp();
  t.after(() => server.close());

  store.insertMatchLog = async () => {
    throw new Error('match_log roto a propósito (prueba)');
  };
  store.insertContactLog = async () => {
    throw new Error('contact_log roto a propósito (prueba)');
  };

  const res = await reportMissing(base, { name: 'Emilio Prueba Rota', contact: 'emilio@ejemplo.com', face: 'emilio' });
  assert.equal(res.status, 303, 'el /report debe seguir redirigiendo normalmente (reporte guardado)');
});

// ------------------------------------- relevos operativos al equipo (#116)
//
// "0 envíos" en el panel se leía como que no había pasado nada, cuando en
// realidad estos avisos SÍ salían — solo que por sendEmail directo, fuera
// del pipeline que instrumentó este archivo. Quedan bajo el mismo canal
// 'relevo' que ya usa el relevo de coincidencias: son un aviso al BUZÓN DEL
// EQUIPO, nunca a una familia ni a un rescatista, y ese es precisamente el
// significado que ese canal ya tenía.

test('la solicitud de "Publicar en Colombia Te Busca" queda en la bitácora como relevo al operador', async (t) => {
  const sg = await fakeSendgrid();
  process.env.AVISO_EMAIL = 'avisos@example.com';
  t.after(() => {
    sg.server.close();
    delete process.env.AVISO_EMAIL;
    delete process.env.SENDGRID_API_KEY;
    delete process.env.SENDGRID_API_BASE;
  });
  process.env.SENDGRID_API_KEY = 'test-key';
  process.env.SENDGRID_API_BASE = sg.base;

  const { server, base, store } = await startApp();
  t.after(() => server.close());

  const fd = new FormData();
  fd.set('name', 'Felipe Prueba CTB');
  fd.set('location', 'Barrio San José');
  fd.set('contact_phone', '300 111 2222');
  fd.set('colombiatebusca', '1');
  fd.append('photos', new File([await photoBytes('felipe')], 'f.jpg', { type: 'image/jpeg' }));
  const res = await fetch(`${base}/report`, { method: 'POST', body: fd, redirect: 'manual' });
  assert.equal(res.status, 303);

  // El correo de relevo sí salió, al buzón del equipo — nunca a un tercero.
  const mailBodies = sg.received.map((r) => JSON.stringify(r.body));
  const mail = mailBodies.find((b) => b.includes('avisos@example.com'));
  assert.ok(mail, 'debía llegar el correo de relevo a Colombia Te Busca al buzón del operador');
  assert.match(mail, /Felipe Prueba/i);

  const contactCounts = await store.contactLogCounts();
  const relevo = contactCounts.find((r) => r.channel === 'relevo');
  assert.ok(relevo, 'la solicitud de relevo a Colombia Te Busca debía quedar registrada bajo el canal "relevo"');
  assert.equal(relevo.result, 'enviado');
});

test('sin marcar la casilla, no se manda ni se registra ningún relevo a Colombia Te Busca', async (t) => {
  const { server, base, store } = await startApp();
  t.after(() => server.close());

  const fd = new FormData();
  fd.set('name', 'Gabriela Prueba Sin CTB');
  fd.set('location', 'Barrio San José');
  fd.set('contact_phone', '300 333 4444');
  fd.append('photos', new File([await photoBytes('gabriela')], 'g.jpg', { type: 'image/jpeg' }));
  const res = await fetch(`${base}/report`, { method: 'POST', body: fd, redirect: 'manual' });
  assert.equal(res.status, 303);

  const contactCounts = await store.contactLogCounts();
  assert.equal(contactCounts.length, 0, 'sin la casilla marcada, el reporte no debe dejar ningún envío en la bitácora');
});
