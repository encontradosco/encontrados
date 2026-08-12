// What a real phone actually uploads, and what the site does with it.
//
// The cases here are the ones that were failing in production: a photo whose
// content type the browser did not label, a photo bigger than the old ceiling,
// and a HEIC that nothing in the stack can decode.
const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { toMatchable } = require('../src/photo');

// Rekognition's real contract: JPEG and PNG only, nothing over 5 MB, and
// "no face here" reported as InvalidParameterException rather than a result.
// The point of these tests is that nothing reaches it that it would refuse.
function rekognitionLike() {
  const seen = [];
  const reject = (name) => {
    const e = new Error(name);
    e.name = name;
    throw e;
  };
  const check = (bytes) => {
    seen.push(bytes);
    if (bytes.length > 5 * 1024 * 1024) reject('ImageTooLargeException');
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    const png = bytes[0] === 0x89 && bytes[1] === 0x50;
    if (!jpeg && !png) reject('InvalidImageFormatException');
  };
  return {
    async ready() {
      return true;
    },
    seen,
    async indexFace(bytes, id) {
      check(bytes);
      return { faceId: `face-${id}`, geometry: null };
    },
    async detectFace(bytes) {
      check(bytes);
      return null;
    },
    async searchByImage(bytes) {
      check(bytes);
      return [];
    }
  };
}

async function startApp(matcher) {
  const app = await createApp(await createSqliteAdapter(':memory:'), matcher);
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}`, store: app.locals.store };
}

const jpeg = (w = 400, h = 500) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 120, g: 90, b: 60 } } })
    .jpeg({ quality: 100 })
    .toBuffer();

// A flat colour compresses to almost nothing at any size, so a fixture that
// has to be genuinely heavy needs real detail in it.
async function noisyJpeg(w, h) {
  const px = Buffer.allocUnsafe(w * h * 3);
  let seed = 7;
  for (let i = 0; i < px.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    px[i] = seed & 255;
  }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } })
    .jpeg({ quality: 100 })
    .toBuffer();
}

async function postReport(base, file) {
  const fd = new FormData();
  fd.set('name', 'Persona Prueba Uno');
  fd.set('location', 'Barrio San José');
  fd.set('contact', '3001234567');
  fd.append('photos', file);
  return fetch(`${base}/report`, { method: 'POST', body: fd, redirect: 'manual' });
}

async function postRescate(base, file) {
  const fd = new FormData();
  fd.append('photo', file);
  return fetch(`${base}/rescate`, { method: 'POST', body: fd, redirect: 'manual' });
}

// The browser labels a photo picked from the Files app, or one that arrived
// over WhatsApp, as application/octet-stream. That used to be dropped without
// an error, and the reporter was told they had forgotten to attach a photo.
test('una foto sin content-type de imagen se sube igual y se indexa', async (t) => {
  const matcher = rekognitionLike();
  const { server, base, store } = await startApp(matcher);
  t.after(() => server.close());

  const file = new File([await jpeg()], 'IMG_0421.jpg', { type: 'application/octet-stream' });
  const res = await postReport(base, file);

  assert.equal(res.status, 303, 'el reporte debe guardarse');
  assert.ok(
    !res.headers.get('location').includes('fotos_ilegibles'),
    'la foto es legible: no debe avisarse lo contrario'
  );
  const id = Number(res.headers.get('location').match(/\/person\/(\d+)/)[1]);
  const stored = (await store.reportPhotoByPerson([id])).get(id);
  assert.ok(stored, 'la foto debe quedar guardada');
  assert.ok(stored.face_id, 'la cara debe quedar indexada, no sólo la foto guardada');
});

// The rescuer flow is the one someone runs standing next to the person they
// just pulled out. An undecodable file used to escape as "Error interno del
// servidor" with no hint of what to do.
test('un HEIC en /rescate explica el problema en vez de dar error interno', async (t) => {
  const { server, base } = await startApp(rekognitionLike());
  t.after(() => server.close());

  // A HEIC container sharp can parse the header of but not decode.
  const heic = Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from('ftypheic'),
    Buffer.alloc(64, 7)
  ]);
  const res = await postRescate(base, new File([heic], 'IMG_1.HEIC', { type: 'image/heic' }));
  const html = await res.text();

  assert.equal(res.status, 200, 'nunca un 500 en la pantalla del rescatista');
  assert.match(html, /No pudimos leer esa foto/);
  assert.match(html, /JPG/, 'debe decir qué hacer al respecto');
  assert.match(html, /<form[^>]+action="\/rescate"/, 'y dejar reintentar sin volver atrás');
});

// The report is the family's data and is never thrown away — but they have to
// be told the photo will not do the job they uploaded it for.
test('un HEIC en /report guarda el reporte y avisa que la foto no sirve', async (t) => {
  const { server, base } = await startApp(rekognitionLike());
  t.after(() => server.close());

  const heic = Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from('ftypheic'),
    Buffer.alloc(64, 7)
  ]);
  const res = await postReport(base, new File([heic], 'IMG_2.HEIC', { type: 'image/heic' }));
  assert.equal(res.status, 303, 'el reporte no se pierde por una foto ilegible');
  const location = res.headers.get('location');
  assert.match(location, /fotos_ilegibles=1/);

  const page = await (await fetch(`${base}${location}`)).text();
  assert.match(page, /no pudimos leer/i, 'la ficha debe decirlo, no dejarlo en silencio');
});

// A current phone camera clears the old 4 MB ceiling without trying, and the
// browser-side shrink is skipped whenever it cannot decode the file.
test('una foto grande se acepta y se reduce antes de guardarla', async (t) => {
  const matcher = rekognitionLike();
  const { server, base, store } = await startApp(matcher);
  t.after(() => server.close());

  const big = await noisyJpeg(3000, 2400);
  assert.ok(big.length > 4 * 1024 * 1024, 'la fixture debe superar el límite viejo');

  const res = await postReport(base, new File([big], 'IMG_3.jpg', { type: 'image/jpeg' }));
  assert.equal(res.status, 303);

  const id = Number(res.headers.get('location').match(/\/person\/(\d+)/)[1]);
  const meta = (await store.reportPhotoByPerson([id])).get(id);
  assert.ok(meta.face_id, 'debe indexarse');
  const stored = await store.getPhoto(meta.id);
  assert.ok(
    stored.content.length < big.length,
    'lo guardado debe ser la versión reducida, no el original'
  );
});

test('toMatchable deja intacta una foto que ya sirve', async () => {
  const bytes = await jpeg(400, 500);
  const out = await toMatchable(bytes, 'image/jpeg');
  assert.equal(out.converted, false, 're-comprimir sin necesidad sólo pierde calidad');
  assert.equal(out.bytes, bytes);
});

test('toMatchable endereza una foto rotada por EXIF', async () => {
  // Orientation 6 = rotated 90°. A sideways face is one Rekognition often
  // does not find at all.
  const rotated = await sharp({
    create: { width: 400, height: 500, channels: 3, background: { r: 10, g: 20, b: 30 } }
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();

  const out = await toMatchable(rotated, 'image/jpeg');
  assert.equal(out.converted, true);
  const meta = await sharp(out.bytes).metadata();
  assert.equal(meta.width, 500, 'la rotación debe quedar aplicada en los píxeles');
  assert.ok(!meta.orientation || meta.orientation === 1);
});

test('toMatchable reporta ilegible en vez de lanzar', async () => {
  assert.equal(await toMatchable(Buffer.from('esto no es una imagen'), 'image/jpeg'), null);
  assert.equal(await toMatchable(Buffer.alloc(0), 'image/jpeg'), null);
});
