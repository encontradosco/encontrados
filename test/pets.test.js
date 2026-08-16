const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { nullMatcher } = require('../src/faces');
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
  // nullMatcher explícito: sin esto, createApp cae en createLazyMatcher()
  // real — si quien corre `npm test` tiene credenciales de AWS en su .env
  // local, esta suite (que no habla de caras) terminaría llamando a
  // Rekognition de verdad. Mismo patrón que ya usa el resto de la suite.
  const app = await createApp(await createSqliteAdapter(':memory:'), nullMatcher);
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

test('GET /api/diag informa el estado del matching de mascotas', async (t) => {
  delete process.env.PET_MATCH_API_URL;
  const { server, base } = await startApp();
  t.after(() => server.close());
  const diag = await (await fetch(`${base}/api/diag`)).json();
  assert.equal(diag.pet_matching.api_url_present, false);
  assert.equal(diag.pet_matching.enabled, false);
});

test('/api/reindex recoge fotos de mascotas que quedaron sin embedding', async (t) => {
  delete process.env.PET_MATCH_API_URL;
  const adapter = await createSqliteAdapter(':memory:');

  // Primera instancia: sin PET_MATCH_API_URL, como si el servicio estuviera caído al reportar.
  // nullMatcher explícito por la misma razón que en startApp() — esta prueba
  // no habla de caras y no debe poder tocar AWS real.
  const app1 = await createApp(adapter, nullMatcher);
  const server1 = await new Promise((resolve) => {
    const s = app1.listen(0, () => resolve(s));
  });
  const base1 = `http://127.0.0.1:${server1.address().port}`;

  const fd = new FormData();
  fd.set('species', 'dog');
  fd.append('photos', new File([await photoBytes({ r: 3, g: 3, b: 3 })], 'p.jpg', { type: 'image/jpeg' }));
  fd.set('contact_phone', '300 000 0000');
  await fetch(`${base1}/mascotas/reporte`, { method: 'POST', body: fd, redirect: 'manual' });
  server1.close();

  // El servicio "vuelve" — se levanta el doble y se pone la variable.
  const pm = await fakePetMatcher();
  t.after(() => pm.stop());

  // Segunda instancia, mismo adapter (misma base): como una instancia nueva
  // que arranca ya con el servicio disponible — no es el MISMO petMatcher
  // "recuperándose", es lo que de verdad pasaría en producción con una
  // instancia serverless nueva.
  const app2 = await createApp(adapter, nullMatcher);
  const server2 = await new Promise((resolve) => {
    const s = app2.listen(0, () => resolve(s));
  });
  t.after(() => server2.close());
  const base2 = `http://127.0.0.1:${server2.address().port}`;

  const res = await fetch(`${base2}/api/reindex`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.pets.processed, 1);
});

test('el sitio enlaza a mascotas desde la navegación', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());
  const html = await (await fetch(base)).text();
  assert.match(html, /href="\/mascotas"/);
});

// El listado de /mascotas es el espejo del de personas en '/' — mismo patrón
// de miniatura diferida (nunca la foto completa de una), mismo contador de
// "reencontradas" y mismo estado vacío.
test('sin mascotas reportadas, /mascotas lo dice explícitamente', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());
  const html = await (await fetch(`${base}/mascotas`)).text();
  assert.match(html, /Todavía no hay mascotas reportadas como perdidas/);
});

test('/mascotas lista lo reportado, con miniatura diferida en vez de la foto completa', async (t) => {
  const pm = await fakePetMatcher();
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    pm.stop();
  });

  const fd = new FormData();
  fd.set('species', 'dog');
  fd.set('pet_name', 'Toby');
  fd.append('photos', new File([await photoBytes({ r: 9, g: 9, b: 9 })], 'toby.jpg', { type: 'image/jpeg' }));
  fd.set('contact_phone', '300 111 2222');
  await fetch(`${base}/mascotas/reporte`, { method: 'POST', body: fd, redirect: 'manual' });

  const html = await (await fetch(`${base}/mascotas`)).text();
  assert.match(html, /Toby/);
  assert.match(html, /Perro/);
  assert.match(html, /class="face pending" data-src="\/pet-photo\/1\/thumb"/);
  assert.ok(!/<img[^>]*\ssrc="\/pet-photo\/1"/.test(html), 'el listado nunca debe cargar la foto completa');
  assert.match(html, /href="\/mascotas\/encontre"[^>]*>👀 Creo que la vi/);
});

test('una mascota marcada como encontrada sale del listado y suma al contador de reencontradas', async (t) => {
  const pm = await fakePetMatcher();
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    pm.stop();
  });

  const fd = new FormData();
  fd.set('species', 'cat');
  fd.append('photos', new File([await photoBytes({ r: 4, g: 4, b: 4 })], 'g.jpg', { type: 'image/jpeg' }));
  fd.set('contact_email', 'duena@ejemplo.com');
  const res = await fetch(`${base}/mascotas/reporte`, { method: 'POST', body: fd, redirect: 'manual' });
  const location = res.headers.get('location').split('?')[0];

  let html = await (await fetch(`${base}/mascotas`)).text();
  assert.match(html, /Gato perdido/);
  assert.ok(!html.includes('reencontrada'), 'todavía no hay ninguna reencontrada');

  await fetch(`${base}${location}/encontrado`, { method: 'POST' });

  html = await (await fetch(`${base}/mascotas`)).text();
  assert.ok(!html.includes('Gato perdido'), 'una mascota ya encontrada no debe seguir en el listado de perdidas');
  assert.match(html, /🎉 1 reencontrada/);
});
