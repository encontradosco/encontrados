const test = require('node:test');
const assert = require('node:assert');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { fakeSendgrid } = require('./helpers');

// Identical bytes = same face, so the whole pipeline runs without AWS.
function fakeMatcher() {
  const indexed = new Map();
  let n = 0;
  const key = (b) => b.toString('utf8');
  return {
    enabled: true,
    calls: { index: 0, search: 0 },
    async indexFace(bytes) {
      this.calls.index++;
      const id = `face-${++n}`;
      if (!indexed.has(key(bytes))) indexed.set(key(bytes), []);
      indexed.get(key(bytes)).push(id);
      return id;
    },
    async searchByImage(bytes) {
      this.calls.search++;
      return (indexed.get(key(bytes)) || []).map((faceId) => ({ faceId, similarity: 97 }));
    }
  };
}

const photoBytes = (label) => Buffer.from(`fake-image:${label}`);

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
  fd.append('photos', new File([photoBytes(face)], 'f.jpg', { type: 'image/jpeg' }));
  return fetch(`${base}/report`, { method: 'POST', body: fd, redirect: 'manual' });
}

test('a rescuer sees who is looking for the person, with their contact', async (t) => {
  const matcher = fakeMatcher();
  const { server, base } = await startApp(matcher);
  t.after(() => server.close());

  await reportMissing(base, {
    name: 'Camila Rojas',
    contact: 'hermana@ejemplo.com · 300 111 2222',
    face: 'camila'
  });

  const fd = new FormData();
  fd.set('photo', new File([photoBytes('camila')], 'rescatada.jpg', { type: 'image/jpeg' }));
  const html = await (await fetch(`${base}/rescate`, { method: 'POST', body: fd })).text();

  assert.match(html, /Camila Rojas/);
  assert.match(html, /Coincidencia facial/);
  assert.match(html, /hermana@ejemplo\.com · 300 111 2222/, 'debe mostrar el contacto de quien la busca');
  assert.match(html, /Borramos tu foto al instante/);
  assert.match(html, /Antes de contactar/, 'debe mostrar la advertencia de verificar identidad sobre las tarjetas');
});

test('a phone-only contact renders as a tap-to-call link', async (t) => {
  const matcher = fakeMatcher();
  const { server, base } = await startApp(matcher);
  t.after(() => server.close());

  await reportMissing(base, { name: 'Laura Gómez', contact: '3001234567', face: 'laura' });

  const fd = new FormData();
  fd.set('photo', new File([photoBytes('laura')], 'rescatada.jpg', { type: 'image/jpeg' }));
  const html = await (await fetch(`${base}/rescate`, { method: 'POST', body: fd })).text();

  assert.match(html, /<a href="tel:3001234567">3001234567<\/a>/);
});

test('an email-only contact renders as a mailto link', async (t) => {
  const matcher = fakeMatcher();
  const { server, base } = await startApp(matcher);
  t.after(() => server.close());

  await reportMissing(base, { name: 'Mario Rojas', contact: 'familia@ejemplo.com', face: 'mario' });

  const fd = new FormData();
  fd.set('photo', new File([photoBytes('mario')], 'rescatada.jpg', { type: 'image/jpeg' }));
  const html = await (await fetch(`${base}/rescate`, { method: 'POST', body: fd })).text();

  assert.match(html, /<a href="mailto:familia@ejemplo\.com">familia@ejemplo\.com<\/a>/);
});

test("the rescuer's photo is never stored, only its face signature", async (t) => {
  const matcher = fakeMatcher();
  const { server, base, store } = await startApp(matcher);
  t.after(() => server.close());

  const fd = new FormData();
  fd.set('photo', new File([photoBytes('desconocido')], 'r.jpg', { type: 'image/jpeg' }));
  await fetch(`${base}/rescate`, { method: 'POST', body: fd });

  const adapter = await createSqliteAdapter(':memory:');
  void adapter;
  const rescuePhotos = (await store.photosByFaceIds(['face-1'])).filter((p) => p.kind === 'query');
  assert.equal(rescuePhotos.length, 1, 'la firma facial debe quedar indexada');

  // No bytes survive anywhere.
  const counts = await store.counts();
  assert.equal(counts.photos_query, 1);
  const raw = await store.photosMissingFaceId(50);
  assert.equal(raw.length, 0, 'la foto de rescate quedó indexada');
});

test('no match tells the rescuer nobody is looking yet', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());
  const fd = new FormData();
  fd.set('photo', new File([photoBytes('nadie')], 'r.jpg', { type: 'image/jpeg' }));
  const html = await (await fetch(`${base}/rescate`, { method: 'POST', body: fd })).text();
  assert.match(html, /Nadie ha reportado a esta persona/);
});

test('a rescuer can subscribe and is alerted when someone reports that person', async (t) => {
  const matcher = fakeMatcher();
  const sg = await fakeSendgrid();
  const { server, base, store } = await startApp(matcher);
  t.after(() => {
    server.close();
    sg.stop();
  });

  // Rescuer uploads a photo and leaves an email
  const fd = new FormData();
  fd.set('photo', new File([photoBytes('nn')], 'r.jpg', { type: 'image/jpeg' }));
  fd.set('email', 'rescatista@ejemplo.com');
  await fetch(`${base}/rescate`, { method: 'POST', body: fd });

  // Verification email went out; confirm it
  assert.equal(sg.received.length, 1);
  const link = /https?:\/\/[^\s]+\/verify\?token=([a-f0-9]+)/.exec(sg.received[0].body.content[0].value);
  assert.ok(link, 'el correo debe traer el enlace de confirmación');
  await fetch(`${base}/verify?token=${link[1]}`);
  sg.received.length = 0;

  // Later, a family reports that same person missing
  await reportMissing(base, { name: 'Rosa Elvira Gil', contact: '300 999 8888', face: 'nn' });

  assert.equal(sg.received.length, 1, 'el rescatista debe recibir el aviso');
  const text = sg.received[0].body.content[0].value;
  assert.match(text, /alguien está buscando a la persona que rescataste/i);
  assert.match(text, /Rosa Elvira Gil/);
  assert.match(text, /300 999 8888/);
  assert.match(text, /unsubscribe\?token=/);
});

test('removed flows are gone: no public search, no family alerts', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());
  for (const path of ['/buscar', '/alerta', '/subscribe-by-name']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  }
});

test('privacy: no route ever serves photo bytes', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());
  for (const path of ['/photos/1', '/photo/1', '/api/photos/1']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404);
  }
});
