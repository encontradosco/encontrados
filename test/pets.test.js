const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { fakePetMatcher } = require('./helpers');

async function photoBytes(color) {
  return sharp({ create: { width: 300, height: 300, channels: 3, background: color } })
    .jpeg()
    .toBuffer();
}

// Un contenedor HEIC cuyo header sharp reconoce pero no puede decodificar —
// mismo truco que test/photo-upload.test.js usa para "una foto ilegible".
function heicBytes() {
  return Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(64, 7)]);
}

async function startApp() {
  const app = await createApp(await createSqliteAdapter(':memory:'));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('reportar una mascota perdida la publica, y "encontré" con la misma foto muestra el contacto', async (t) => {
  const pm = await fakePetMatcher();
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    pm.stop();
  });

  const fd = new FormData();
  fd.set('species', 'dog');
  fd.set('pet_name', 'Toby');
  fd.set('description', 'Mediano, negro, collar rojo');
  fd.set('contact_phone', '300 111 2222');
  fd.append('photos', new File([await photoBytes({ r: 10, g: 10, b: 10 })], 'toby.jpg', { type: 'image/jpeg' }));
  const reportRes = await fetch(`${base}/mascotas/reporte`, { method: 'POST', body: fd, redirect: 'manual' });
  assert.equal(reportRes.status, 303);
  const location = reportRes.headers.get('location');
  assert.match(location, /^\/mascota\/\d+\?reported=1$/);

  const fichaHtml = await (await fetch(`${base}${location}`)).text();
  assert.match(fichaHtml, /Toby/);
  assert.match(fichaHtml, /Mediano, negro, collar rojo/);
  assert.match(fichaHtml, /pet-photo\/1\/thumb/);

  pm.respondWith([1, 0, 0]); // el mismo vector que ya devolvió para la foto del reporte
  const fd2 = new FormData();
  fd2.set('species', 'dog');
  fd2.append('photo', new File([await photoBytes({ r: 200, g: 200, b: 200 })], 'encontrado.jpg', { type: 'image/jpeg' }));
  const html = await (await fetch(`${base}/mascotas/encontre`, { method: 'POST', body: fd2 })).text();

  assert.match(html, /Toby/);
  assert.match(html, /300 111 2222/);
});

test('especies distintas no coinciden, y sin coincidencia lo dice claro', async (t) => {
  const pm = await fakePetMatcher();
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    pm.stop();
  });

  const fd = new FormData();
  fd.set('species', 'cat');
  fd.append('photos', new File([await photoBytes({ r: 1, g: 1, b: 1 })], 'gato.jpg', { type: 'image/jpeg' }));
  fd.set('contact_email', 'duena@ejemplo.com');
  await fetch(`${base}/mascotas/reporte`, { method: 'POST', body: fd, redirect: 'manual' });

  const fd2 = new FormData();
  fd2.set('species', 'dog');
  fd2.append('photo', new File([await photoBytes({ r: 1, g: 1, b: 1 })], 'perro.jpg', { type: 'image/jpeg' }));
  const html = await (await fetch(`${base}/mascotas/encontre`, { method: 'POST', body: fd2 })).text();
  assert.match(html, /Nadie ha reportado una mascota parecida/);
});

test('la foto de quien encontró la mascota nunca se puede servir públicamente', async (t) => {
  const pm = await fakePetMatcher();
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    pm.stop();
  });

  const fd = new FormData();
  fd.set('species', 'dog');
  fd.append('photos', new File([await photoBytes({ r: 5, g: 5, b: 5 })], 'p.jpg', { type: 'image/jpeg' }));
  fd.set('contact_phone', '300 999 8888');
  await fetch(`${base}/mascotas/reporte`, { method: 'POST', body: fd, redirect: 'manual' });

  const fd2 = new FormData();
  fd2.set('species', 'dog');
  fd2.append('photo', new File([await photoBytes({ r: 5, g: 5, b: 5 })], 'q.jpg', { type: 'image/jpeg' }));
  await fetch(`${base}/mascotas/encontre`, { method: 'POST', body: fd2 });

  // La foto 1 es el reporte (se sirve), la 2 es la de "encontré" (nunca).
  assert.equal((await fetch(`${base}/pet-photo/1`)).status, 200);
  assert.equal((await fetch(`${base}/pet-photo/2`)).status, 404);
  assert.equal((await fetch(`${base}/pet-photo/2/thumb`)).status, 404);
});

test('sin PET_MATCH_API_URL, el formulario de "encontré" lo dice y no rompe nada', async (t) => {
  delete process.env.PET_MATCH_API_URL;
  const { server, base } = await startApp();
  t.after(() => server.close());

  const fd = new FormData();
  fd.set('species', 'dog');
  fd.append('photo', new File([await photoBytes({ r: 7, g: 7, b: 7 })], 'q.jpg', { type: 'image/jpeg' }));
  const html = await (await fetch(`${base}/mascotas/encontre`, { method: 'POST', body: fd })).text();
  assert.match(html, /no está disponible/);
});

test('un reporte exitoso, sin fotos ilegibles, muestra la confirmación en la ficha', async (t) => {
  const pm = await fakePetMatcher();
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    pm.stop();
  });

  const fd = new FormData();
  fd.set('species', 'dog');
  fd.set('pet_name', 'Firulais');
  fd.set('contact_phone', '300 444 5555');
  fd.append('photos', new File([await photoBytes({ r: 3, g: 3, b: 3 })], 'firulais.jpg', { type: 'image/jpeg' }));
  const res = await fetch(`${base}/mascotas/reporte`, { method: 'POST', body: fd, redirect: 'manual' });
  const location = res.headers.get('location');
  assert.match(location, /^\/mascota\/\d+\?reported=1$/);

  const html = await (await fetch(`${base}${location}`)).text();
  assert.match(html, /Reporte registrado/);
});

test('una foto ilegible entre varias no rompe el reporte, y la ficha lo dice sin dejar un <img> roto', async (t) => {
  const pm = await fakePetMatcher();
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    pm.stop();
  });

  const fd = new FormData();
  fd.set('species', 'dog');
  fd.set('contact_phone', '300 666 7777');
  fd.append('photos', new File([heicBytes()], 'ilegible.heic', { type: 'image/heic' }));
  fd.append('photos', new File([await photoBytes({ r: 4, g: 4, b: 4 })], 'legible.jpg', { type: 'image/jpeg' }));
  const res = await fetch(`${base}/mascotas/reporte`, { method: 'POST', body: fd, redirect: 'manual' });
  const location = res.headers.get('location');
  assert.match(location, /fotos_ilegibles=1/);

  const html = await (await fetch(`${base}${location}`)).text();
  assert.match(html, /no pudimos leer/i);
  const imgTags = html.match(/<img src="\/pet-photo\//g) || [];
  assert.equal(imgTags.length, 1, 'solo la foto legible debe tener un <img>, no una rota para la ilegible');
});

test('marcar una mascota como encontrada lo refleja en su ficha', async (t) => {
  const pm = await fakePetMatcher();
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    pm.stop();
  });

  const fd = new FormData();
  fd.set('species', 'cat');
  fd.append('photos', new File([await photoBytes({ r: 2, g: 2, b: 2 })], 'g.jpg', { type: 'image/jpeg' }));
  fd.set('contact_email', 'duena@ejemplo.com');
  const res = await fetch(`${base}/mascotas/reporte`, { method: 'POST', body: fd, redirect: 'manual' });
  const location = res.headers.get('location').split('?')[0];

  await fetch(`${base}${location}/encontrado`, { method: 'POST' });
  const html = await (await fetch(`${base}${location}`)).text();
  assert.match(html, /ya fue encontrada/);
});
