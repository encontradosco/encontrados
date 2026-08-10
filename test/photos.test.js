const test = require('node:test');
const assert = require('node:assert');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createStore } = require('../src/people');
const { createApp } = require('../src/server');
const { handleInbound } = require('../src/bot');
const { processPhoto } = require('../src/facematch');

// Fake matcher: identical bytes = same face. Lets us test the whole match
// pipeline without AWS.
function fakeMatcher() {
  const indexed = new Map(); // key(bytes) -> [faceId]
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
      return (indexed.get(key(bytes)) || []).map((faceId) => ({ faceId, similarity: 99 }));
    }
  };
}

const photoBytes = (label) => Buffer.from(`fake-image:${label}`);

async function startApp(matcher) {
  const app = await createApp(await createSqliteAdapter(':memory:'), matcher);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}`, store: app.locals.store };
}

test('query photos + matching report photo triggers cross-match', async () => {
  const store = createStore(await createSqliteAdapter(':memory:'));
  const matcher = fakeMatcher();

  // Searcher subscribes to "Camila Rojas" with 2 photos
  const { person: camila } = await store.findOrCreatePerson('Camila Rojas');
  const { sub } = await store.subscribe(camila.id, 'email', 'buscadora@ejemplo.com');
  await store.verifySubscription(sub.verify_token);
  await processPhoto(store, matcher, {
    personId: camila.id, kind: 'query', subscriptionId: sub.id,
    bytes: photoBytes('camila-face'), contentType: 'image/jpeg'
  });
  await processPhoto(store, matcher, {
    personId: camila.id, kind: 'query', subscriptionId: sub.id,
    bytes: photoBytes('camila-face-2'), contentType: 'image/jpeg'
  });
  assert.equal(await store.countQueryPhotos(sub.id), 2);

  // A report arrives under a DIFFERENT name but with the same face
  const { person: desconocida } = await store.findOrCreatePerson('Mujer sin identificar');
  const update = await store.addUpdate(desconocida.id, { status: 'safe', source: 'web' });
  const reportPhoto = await processPhoto(store, matcher, {
    personId: desconocida.id, kind: 'report', updateId: update.id,
    bytes: photoBytes('camila-face'), contentType: 'image/jpeg'
  });

  assert.ok(reportPhoto.id);
  assert.ok(matcher.calls.search >= 3);
  // the report photo's search found the query photo's face
  const matched = await store.photosByFaceIds(['face-1']);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].kind, 'query');
  assert.equal(matched[0].subscription_id, sub.id);
});

test('web: multipart report with photo stores it', async (t) => {
  const matcher = fakeMatcher();
  const { server, base, store } = await startApp(matcher);
  t.after(() => server.close());

  const fd = new FormData();
  fd.set('name', 'Andrés Felipe Castro');
  fd.set('status', 'safe');
  fd.set('message', 'Visto en el parque principal');
  fd.set('photo', new File([photoBytes('andres')], 'foto.jpg', { type: 'image/jpeg' }));

  const res = await fetch(`${base}/report`, { method: 'POST', body: fd, redirect: 'manual' });
  assert.equal(res.status, 303);
  assert.equal(matcher.calls.index, 1);

  const [person] = await store.searchPeople('andres castro');
  assert.ok(person);
  const page = await fetch(`${base}${res.headers.get('location')}`);
  assert.match(await page.text(), /Andrés Felipe Castro/);
});

test('web: subscribe form accepts up to 3 query photos', async (t) => {
  const matcher = fakeMatcher();
  const { server, base, store } = await startApp(matcher);
  t.after(() => server.close());

  const { person } = await store.findOrCreatePerson('Rosa Elvira Gil');
  const fd = new FormData();
  fd.set('email', 'familia.gil@ejemplo.com');
  for (const i of [1, 2, 3, 4]) {
    fd.append('photos', new File([photoBytes(`rosa-${i}`)], `f${i}.jpg`, { type: 'image/jpeg' }));
  }
  const res = await fetch(`${base}/person/${person.id}/subscribe`, {
    method: 'POST',
    body: fd,
    redirect: 'manual'
  });
  assert.equal(res.status, 303);
  const [sub] = await store.getSubscriptions(person.id);
  // capped at 3 even though 4 were sent (multer rejects the extra file)
  assert.ok((await store.countQueryPhotos(sub.id)) <= 3);
  assert.ok((await store.countQueryPhotos(sub.id)) >= 1);
});

test('bot: whatsapp report and subscribe with photo', async () => {
  const store = createStore(await createSqliteAdapter(':memory:'));
  const matcher = fakeMatcher();

  const r1 = await handleInbound(store, {
    channel: 'whatsapp', from: '573001', text: 'BIEN Diego Torres',
    photo: { bytes: photoBytes('diego'), contentType: 'image/jpeg' }, matcher
  });
  assert.match(r1, /Foto recibida/);
  assert.match(r1, /reconocimiento facial/);

  const r2 = await handleInbound(store, {
    channel: 'whatsapp', from: '573002', text: 'SUSCRIBIR Diego Torres',
    photo: { bytes: photoBytes('diego-buscador'), contentType: 'image/jpeg' }, matcher
  });
  assert.match(r2, /Foto guardada/);
  assert.match(r2, /Nunca se compartirá/);
});

test('api: photo on updates and subscriptions', async (t) => {
  const matcher = fakeMatcher();
  const { server, base } = await startApp(matcher);
  t.after(() => server.close());

  const post = await fetch(`${base}/api/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Paula Mejía',
      status: 'missing',
      photo: { base64: photoBytes('paula').toString('base64'), content_type: 'image/jpeg' }
    })
  });
  assert.equal(post.status, 201);
  assert.equal((await post.json()).photo_stored, true);

  const search = await fetch(`${base}/api/people?q=paula mejia`);
  const { results } = await search.json();
  const sub = await fetch(`${base}/api/people/${results[0].id}/subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channel: 'email',
      address: 'tia@ejemplo.com',
      photos: [{ base64: photoBytes('paula').toString('base64'), content_type: 'image/jpeg' }]
    })
  });
  assert.equal(sub.status, 201);
  const body = await sub.json();
  assert.equal(body.photos_stored, 1);
  assert.equal(body.pending_verification, true);
});

test('privacy: no route ever serves photo bytes', async (t) => {
  const { server, base } = await startApp(fakeMatcher());
  t.after(() => server.close());
  for (const path of ['/photos/1', '/photo/1', '/api/photos/1']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 404);
  }
});

test('buscar: photo search returns immediate face matches', async (t) => {
  const matcher = fakeMatcher();
  const { server, base, store } = await startApp(matcher);
  t.after(() => server.close());

  // existing report with photo
  const { person } = await store.findOrCreatePerson('Sofía Herrera');
  const update = await store.addUpdate(person.id, { status: 'safe', source: 'web' });
  const { processPhoto } = require('../src/facematch');
  await processPhoto(store, matcher, {
    personId: person.id, kind: 'report', updateId: update.id,
    bytes: photoBytes('sofia'), contentType: 'image/jpeg'
  });

  // search by the same face, no name
  const fd = new FormData();
  fd.set('q', '');
  fd.append('photos', new File([photoBytes('sofia')], 'f.jpg', { type: 'image/jpeg' }));
  const res = await fetch(`${base}/buscar`, { method: 'POST', body: fd });
  const html = await res.text();
  assert.match(html, /Posibles coincidencias por rostro/);
  assert.match(html, /Sofía Herrera/);
  assert.match(html, /Coincidencia facial: 99%/);
});

test('subscribe alias: POST /person/:id works like /subscribe', async (t) => {
  const { server, base, store } = await startApp(fakeMatcher());
  t.after(() => server.close());
  const { person } = await store.findOrCreatePerson('Iván Prieto');
  const res = await fetch(`${base}/person/${person.id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'alias@ejemplo.com' }),
    redirect: 'manual'
  });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /revisa-tu-correo/);
});

test('report without name but with photo creates unidentified person', async (t) => {
  const matcher = fakeMatcher();
  const { server, base, store } = await startApp(matcher);
  t.after(() => server.close());

  const fd = new FormData();
  fd.set('name', '');
  fd.set('status', 'injured');
  fd.set('message', 'Encontrada inconsciente cerca del parque');
  fd.set('photo', new File([photoBytes('desconocida')], 'foto.jpg', { type: 'image/jpeg' }));
  const res = await fetch(`${base}/report`, { method: 'POST', body: fd, redirect: 'manual' });
  assert.equal(res.status, 303);

  const page = await fetch(`${base}${res.headers.get('location')}`);
  assert.match(await page.text(), /Persona sin identificar/);
  assert.equal(matcher.calls.index, 1);

  // no name and no photo → rejected
  const bad = await fetch(`${base}/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: '', status: 'safe' })
  });
  assert.equal(bad.status, 400);
});

test('backfill indexes photos stored while matching was down and notifies', async (t) => {
  const { nullMatcher } = require('../src/faces');
  const { backfillUnindexedPhotos } = require('../src/facematch');
  const adapter = await createSqliteAdapter(':memory:');
  const store = createStore(adapter);

  // A searcher subscribed (verified) with a photo while matching was DOWN
  const { person: buscada } = await store.findOrCreatePerson('Marta Quintero');
  const { sub } = await store.subscribe(buscada.id, 'email', 'hermano@ejemplo.com');
  await store.verifySubscription(sub.verify_token);
  await processPhoto(store, nullMatcher, {
    personId: buscada.id, kind: 'query', subscriptionId: sub.id,
    bytes: photoBytes('marta'), contentType: 'image/jpeg'
  });

  // A report with the same face was also filed while matching was DOWN
  const { person: nn } = await store.findOrCreatePerson('Persona sin identificar ab12');
  const update = await store.addUpdate(nn.id, { status: 'injured', source: 'web' });
  await processPhoto(store, nullMatcher, {
    personId: nn.id, kind: 'report', updateId: update.id,
    bytes: photoBytes('marta'), contentType: 'image/jpeg'
  });

  // Nothing indexed yet
  assert.equal((await store.photosMissingFaceId(50)).length, 2);

  // Matching comes back online → backfill finds the missed coincidence
  const matcher = fakeMatcher();
  const result = await backfillUnindexedPhotos(store, matcher, 50);
  assert.equal(result.ok, true);
  assert.equal(result.processed, 2);
  assert.equal(result.notifications, 1);
  assert.equal((await store.photosMissingFaceId(50)).length, 0);

  // Running again is a no-op
  const again = await backfillUnindexedPhotos(store, matcher, 50);
  assert.equal(again.processed, 0);
});
