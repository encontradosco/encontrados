const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { fakeSendgrid } = require('./helpers');

// Same shape Rekognition returns: every coordinate a ratio of the image.
const FAKE_GEOMETRY = {
  box: { l: 0.25, t: 0.1, w: 0.5, h: 0.6 },
  points: [
    { t: 'eyeLeft', x: 0.4, y: 0.3 },
    { t: 'eyeRight', x: 0.6, y: 0.3 },
    { t: 'nose', x: 0.5, y: 0.45 }
  ],
  pose: { roll: 1, yaw: -2, pitch: 3 },
  confidence: 99.5
};

// Identical bytes = same face, so the whole pipeline runs without AWS.
function fakeMatcher() {
  const indexed = new Map();
  let n = 0;
  const key = (b) => b.toString('utf8');
  return {
    enabled: true,
    calls: { index: 0, search: 0, detect: 0 },
    async indexFace(bytes) {
      this.calls.index++;
      const id = `face-${++n}`;
      if (!indexed.has(key(bytes))) indexed.set(key(bytes), []);
      indexed.get(key(bytes)).push(id);
      return { faceId: id, geometry: FAKE_GEOMETRY };
    },
    async detectFace() {
      this.calls.detect++;
      return FAKE_GEOMETRY;
    },
    async searchByImage(bytes) {
      this.calls.search++;
      return (indexed.get(key(bytes)) || []).map((faceId) => ({ faceId, similarity: 97 }));
    }
  };
}

// Real JPEGs, because thumbnails are actually decoded and cropped. One flat
// colour per label: distinct bytes, so the fake matcher still reads them as
// distinct faces. 400x500 keeps the crop math below deterministic.
const jpegCache = new Map();
async function photoBytes(label) {
  if (!jpegCache.has(label)) {
    let h = 0;
    for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) % 16777216;
    jpegCache.set(
      label,
      await sharp({
        create: {
          width: 400,
          height: 500,
          channels: 3,
          background: { r: (h >> 16) & 255, g: (h >> 8) & 255, b: h & 255 }
        }
      })
        .jpeg()
        .toBuffer()
    );
  }
  return jpegCache.get(label);
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
  fd.set('photo', new File([await photoBytes('camila')], 'rescatada.jpg', { type: 'image/jpeg' }));
  const html = await (await fetch(`${base}/rescate`, { method: 'POST', body: fd })).text();

  assert.match(html, /Camila Rojas/);
  assert.match(html, /Coincidencia facial/);
  assert.match(html, /hermana@ejemplo\.com · 300 111 2222/, 'debe mostrar el contacto de quien la busca');
  assert.match(html, /ya fue borrada/);
});

test("the rescuer's photo is never stored, only its face signature", async (t) => {
  const matcher = fakeMatcher();
  const { server, base, store } = await startApp(matcher);
  t.after(() => server.close());

  const fd = new FormData();
  fd.set('photo', new File([await photoBytes('desconocido')], 'r.jpg', { type: 'image/jpeg' }));
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
  fd.set('photo', new File([await photoBytes('nadie')], 'r.jpg', { type: 'image/jpeg' }));
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
  fd.set('photo', new File([await photoBytes('nn')], 'r.jpg', { type: 'image/jpeg' }));
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

// Report photos are public on purpose. A RESCUER's photo is not: its bytes are
// dropped at upload, and /photo/:id refuses to serve 'query' rows regardless.
test("privacy: /photo/:id serves report photos but never a rescuer's", async (t) => {
  const { server, base, store } = await startApp();
  t.after(() => server.close());

  await reportMissing(base, { name: 'Lucía Ortega', contact: '300 555 1111', face: 'lucia' });

  const fd = new FormData();
  fd.set('photo', new File([await photoBytes('lucia')], 'rescatada.jpg', { type: 'image/jpeg' }));
  fd.set('email', 'rescatista@ejemplo.com');
  await fetch(`${base}/rescate`, { method: 'POST', body: fd });

  const counts = await store.counts();
  assert.equal(counts.photos_report, 1);
  assert.equal(counts.photos_query, 1);

  // Walk every photo row: report rows serve their bytes, query rows 404.
  let served = 0;
  for (let id = 1; id <= counts.photos; id++) {
    const photo = await store.getPhoto(id);
    const res = await fetch(`${base}/photo/${id}`);
    if (photo.kind === 'report') {
      assert.equal(res.status, 200, `report photo ${id} should be served`);
      assert.match(res.headers.get('content-type'), /^image\//);
      assert.ok((await res.arrayBuffer()).byteLength > 0);
      served++;
    } else {
      assert.equal(res.status, 404, `rescuer photo ${id} must never be served`);
    }
  }
  assert.equal(served, 1);

  // No other photo route exists, and unknown ids stay 404.
  for (const path of ['/photos/1', '/api/photos/1', '/photo/9999', '/photo/abc']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  }
});

test('the missing list defers the thumbnail instead of loading the full photo', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  await reportMissing(base, { name: 'Andrés Beltrán', contact: '300 555 2222', face: 'andres' });

  const html = await (await fetch(base)).text();
  // No <img> is rendered at all: PHOTO_SCRIPT builds it, and only if the
  // connection can afford it. Only the <noscript> copy fetches unconditionally.
  assert.match(html, /class="face pending" data-src="\/photo\/1\/thumb"/);
  assert.ok(!/<img[^>]*\ssrc="\/photo\/1"/.test(html), 'la lista nunca carga la foto completa');
  assert.match(html, /<noscript><img class="face-noscript" src="\/photo\/1\/thumb"/);
  assert.match(html, /class="face-load"/);
});

test('thumbnails only load when the connection can afford them', () => {
  const { thumbnailsAreAffordable } = require('../src/html');

  // Fast enough: load.
  assert.equal(thumbnailsAreAffordable({ effectiveType: '4g', downlink: 10 }), true);
  assert.equal(thumbnailsAreAffordable({ effectiveType: '3g', downlink: 1.2 }), true);
  // Too slow: don't.
  assert.equal(thumbnailsAreAffordable({ effectiveType: '3g', downlink: 0.2 }), false);
  assert.equal(thumbnailsAreAffordable({ effectiveType: '2g', downlink: 0.1 }), false);
  assert.equal(thumbnailsAreAffordable({ effectiveType: 'slow-2g', downlink: 0.05 }), false);
  // Data saver wins over any speed.
  assert.equal(thumbnailsAreAffordable({ effectiveType: '4g', downlink: 10, saveData: true }), false);
  // Browsers without the Network Information API (Safari, Firefox) still get
  // photos — refusing everyone we can't measure would be worse.
  assert.equal(thumbnailsAreAffordable(undefined), true);
  assert.equal(thumbnailsAreAffordable({}), true);
});

test('the connection rule shipped to the browser is the one tested here', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());
  const { thumbnailsAreAffordable } = require('../src/html');
  const html = await (await fetch(base)).text();
  assert.ok(html.includes(thumbnailsAreAffordable.toString()), 'el script debe llevar la misma función');
});

test('the overlay is remapped onto the thumbnail crop', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  await reportMissing(base, { name: 'Andrés Beltrán', contact: '300 555 2222', face: 'andres' });

  const html = await (await fetch(base)).text();
  // The photo is 400x500 and the face box is {l:.25,t:.1,w:.5,h:.6}, so the
  // crop is the 400x400 square at the top: crop = {l:0,t:0,w:1,h:0.8}.
  // The box maps to t = 0.1/0.8 = 0.125 and h = 0.6/0.8 = 0.75; left/width are
  // unchanged because the crop spans the full width.
  assert.match(html, /class="face-box" style="left:25\.000%;top:12\.500%;width:50\.000%;height:75\.000%"/);
  // eyeLeft (0.4, 0.3) -> y = 0.3/0.8 = 0.375
  assert.match(html, /class="face-pt" style="left:40\.000%;top:37\.500%"/);
  assert.match(html, /title="ojo izquierdo"/);
  assert.equal((html.match(/class="face-pt"/g) || []).length, 3);
});

test('the person page shows the face bigger, and no duplicated location', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  await reportMissing(base, { name: 'Andrés Beltrán', contact: '300 555 2222', face: 'andres' });
  const html = await (await fetch(`${base}/person/1`)).text();

  // The bigger page pulls the bigger crop, not the listing's 80px one.
  assert.match(html, /class="face pending large" data-src="\/photo\/1\/face"/);
  assert.match(html, /class="face-box"/);

  const big = Buffer.from(await (await fetch(`${base}/photo/1/face`)).arrayBuffer());
  const small = Buffer.from(await (await fetch(`${base}/photo/1/thumb`)).arrayBuffer());
  assert.equal((await sharp(big).metadata()).width, 400, 'no se reescala más allá del original');
  assert.equal((await sharp(small).metadata()).width, 240);
  assert.ok(big.length > small.length);

  // The only report IS the located one, so the card already says where they
  // were seen — repeating it in a banner above adds nothing.
  assert.equal((html.match(/Barrio San José/g) || []).length, 1);
  assert.ok(!html.includes('Última ubicación reportada'));
});

test('the location banner comes back when the newest report lacks a location', async (t) => {
  const { server, base, store } = await startApp();
  t.after(() => server.close());

  await reportMissing(base, { name: 'Andrés Beltrán', contact: '300 555 2222', face: 'andres' });
  // A newer report with no location: now where they were last seen is buried.
  await store.addUpdate(1, { status: 'missing', message: 'Seguimos buscando', source: 'web' });

  const html = await (await fetch(`${base}/person/1`)).text();
  assert.match(html, /Última ubicación reportada/);
  assert.equal((html.match(/Barrio San José/g) || []).length, 2, 'banner + tarjeta original');
});

test('the thumbnail is a small square crop, far lighter than the full photo', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  await reportMissing(base, { name: 'Andrés Beltrán', contact: '300 555 2222', face: 'andres' });

  const thumb = await fetch(`${base}/photo/1/thumb`);
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers.get('content-type'), 'image/jpeg');
  const bytes = Buffer.from(await thumb.arrayBuffer());
  const meta = await sharp(bytes).metadata();
  assert.equal(meta.width, 240);
  assert.equal(meta.height, 240);

  const full = Buffer.from(await (await fetch(`${base}/photo/1`)).arrayBuffer());
  assert.ok(bytes.length < full.length, 'la miniatura debe pesar menos que la foto completa');
});

test('a photo without detection geometry still gets a centred thumbnail', async (t) => {
  const matcher = fakeMatcher();
  matcher.indexFace = async () => ({ faceId: 'face-x', geometry: null });
  const { server, base } = await startApp(matcher);
  t.after(() => server.close());

  await reportMissing(base, { name: 'Sara Nieto', contact: '300 555 3333', face: 'sara' });

  const html = await (await fetch(base)).text();
  assert.match(html, /data-src="\/photo\/1\/thumb"/);
  assert.ok(!html.includes('face-pt'));
  assert.ok(!html.includes('face-box'));
  assert.equal((await fetch(`${base}/photo/1/thumb`)).status, 200);
});

test('reindex backfills thumbnails and geometry for photos stored earlier', async (t) => {
  // Face matching down at upload time: the photo is stored unindexed, and gets
  // a centred thumbnail so the listing still has something to show.
  const { server, base, store } = await startApp({ enabled: false });
  t.after(() => server.close());

  await reportMissing(base, { name: 'Iván Salazar', contact: '300 555 4444', face: 'ivan' });
  let photo = await store.getPhoto(1);
  assert.equal(photo.face_id, null);
  assert.ok(photo.thumb && photo.thumb.length, 'debe haber miniatura aunque no haya reconocimiento');
  assert.ok(!photo.face_detail.box, 'todavía no se sabe dónde está el rostro');

  // Rekognition comes back: reindex fills in the geometry and reframes the crop.
  const { backfillPhotoDerivatives } = require('../src/facematch');
  const result = await backfillPhotoDerivatives(store, fakeMatcher(), 100);
  assert.equal(result.thumbnails, 1);
  assert.equal(result.geometry, 1);

  photo = await store.getPhoto(1);
  assert.deepEqual(photo.face_detail.box, FAKE_GEOMETRY.box);
  assert.ok(photo.face_detail.crop, 'la miniatura debe registrar su recorte');
  assert.match((await (await fetch(base)).text()), /class="face-box"/);

  // Nothing left to do on a second pass.
  const again = await backfillPhotoDerivatives(store, fakeMatcher(), 100);
  assert.equal(again.processed, 0);
});

test('/fotos/actualizar brings photos up to date without an API key', async (t) => {
  const { server, base, store } = await startApp({ enabled: false });
  t.after(() => server.close());

  await reportMissing(base, { name: 'Iván Salazar', contact: '300 555 4444', face: 'ivan' });
  // Strip the derivatives, as if this photo predated thumbnails entirely.
  await store.setPhotoThumbnails(1, { small: null, large: null, contentType: null });
  await store.setPhotoFaceDetail(1, null);

  // No Authorization header anywhere: this is meant to be opened in a browser.
  const first = await fetch(`${base}/fotos/actualizar`);
  assert.equal(first.status, 200);
  const html = await first.text();
  assert.match(html, /Procesadas <strong>1<\/strong>/);

  // Idempotent, and it stops asking for more: with matching down there is
  // nothing left this run could improve, so it must not loop forever.
  const second = await (await fetch(`${base}/fotos/actualizar`)).text();
  assert.match(second, /Todas las fotos están al día/);
  assert.match(second, /les falta ubicar el rostro/);

  // And once Rekognition is back, that same photo does get reframed.
  const { backfillPhotoDerivatives } = require('../src/facematch');
  const result = await backfillPhotoDerivatives(store, fakeMatcher(), 100);
  assert.equal(result.geometry, 1);
  assert.deepEqual((await store.getPhoto(1)).face_detail.box, FAKE_GEOMETRY.box);
});

test('existing names get re-capitalized, without touching how they match', async (t) => {
  const { server, base, store } = await startApp({ enabled: false });
  t.after(() => server.close());

  // New rows are cased on insert, so write the old shape in directly — that is
  // exactly what the rows created before titleCaseName existed look like.
  const { person } = await store.findOrCreatePerson('Emmanuel Paul Prieto Travieso');
  await store.addUpdate(person.id, { status: 'missing', source: 'api' });
  await store.updatePersonName(person.id, 'EMMANUEL PAUL PRIETO TRAVIESO');
  await store.findOrCreatePerson('Otra Persona');

  const before = await store.getPerson(person.id);
  assert.equal(before.full_name, 'EMMANUEL PAUL PRIETO TRAVIESO');
  const matchesBefore = await store.searchPeople('emmanuel prieto');
  assert.ok(matchesBefore.length);

  const result = await store.recasePersonNames(500);
  assert.ok(result.checked >= 2);

  // Idempotent: a second pass finds nothing left to fix.
  assert.equal((await store.recasePersonNames(500)).fixed.length, 0);

  const after = await store.getPerson(person.id);
  assert.equal(after.full_name, 'Emmanuel Paul Prieto Travieso');

  // Search still finds them exactly as before: only the display name moved.
  const matchesAfter = await store.searchPeople('emmanuel prieto');
  assert.deepEqual(matchesAfter.map((m) => m.id), matchesBefore.map((m) => m.id));

  assert.match(await (await fetch(base)).text(), /Emmanuel Paul Prieto Travieso/);
});

test('/mantenimiento re-capitalizes names without an API key', async (t) => {
  const { server, base, store } = await startApp({ enabled: false });
  t.after(() => server.close());

  const { person } = await store.findOrCreatePerson('Carolina Gutierrez Vasquez');
  await store.addUpdate(person.id, { status: 'missing', source: 'api' });
  await store.updatePersonName(person.id, 'CAROLINA GUTIERREZ VASQUEZ');

  const html = await (await fetch(`${base}/mantenimiento`)).text();
  assert.match(html, /Recapitalizados/);
  assert.match(html, /Carolina Gutierrez Vasquez/);
  assert.equal((await store.getPerson(person.id)).full_name, 'Carolina Gutierrez Vasquez');

  // The old URL still works, so a bookmarked link doesn't break.
  assert.equal((await fetch(`${base}/fotos/actualizar`)).status, 200);
});

test('viewing the home page catches old photos up on its own', async (t) => {
  const { server, base, store } = await startApp({ enabled: false });
  t.after(() => server.close());

  await reportMissing(base, { name: 'Rosa Gil', contact: '300 555 5555', face: 'rosa' });
  // Drop the derivatives, as if this photo predated thumbnails entirely.
  await store.setPhotoThumbnails(1, { small: null, large: null, contentType: null });
  await store.setPhotoFaceDetail(1, null);
  assert.equal((await store.photosMissingDerivatives(10)).length, 1);

  await fetch(base);
  // The sweep runs after the response, so give it a moment to land.
  for (let i = 0; i < 40 && (await store.photosMissingDerivatives(10)).length; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const photo = await store.getPhoto(1);
  assert.ok(photo.thumb && photo.thumb.length, 'la miniatura debe haberse generado sola');
});
