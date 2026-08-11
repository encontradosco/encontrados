const test = require('node:test');
const assert = require('node:assert');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createStore } = require('../src/people');
const { createApp } = require('../src/server');
const { nullMatcher } = require('../src/faces');
const { findDuplicateCandidates } = require('../src/duplicates');

// A matcher that reports every photo as the same face, so the face path can be
// exercised without AWS. `searchByImage` answers with whatever face ids have
// been indexed so far — exactly the shape Rekognition returns. `blindTo` lets a
// test make specific photo bytes return nothing, the way a group shot with no
// usable face does in practice.
function fakeMatcher({ blindTo = [] } = {}) {
  let next = 1;
  const indexed = [];
  const searched = [];
  return {
    enabled: true,
    status: 'fake',
    searched,
    async indexFace() {
      const faceId = `face-${next++}`;
      indexed.push(faceId);
      return { faceId, geometry: null };
    },
    async detectFace() {
      return null;
    },
    async thumbnails() {
      return {};
    },
    async searchByImage(bytes) {
      const body = Buffer.from(bytes).toString();
      searched.push(body);
      if (blindTo.includes(body)) return [];
      return indexed.map((faceId) => ({ faceId, similarity: 97 }));
    }
  };
}

async function startApp(matcher = nullMatcher) {
  const app = await createApp(await createSqliteAdapter(':memory:'), matcher);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}`, store: app.locals.store };
}

function reportForm({ name, location = 'Barrio Centro', contact = '300 123 4567', photos = ['foto'] }) {
  const fd = new FormData();
  fd.set('name', name);
  fd.set('location', location);
  fd.set('contact', contact);
  for (const [i, body] of photos.entries()) {
    fd.append('photos', new File([Buffer.from(body)], `f${i}.jpg`, { type: 'image/jpeg' }));
  }
  return fd;
}

const post = (base, body) =>
  fetch(`${base}/report`, { method: 'POST', body, redirect: 'manual' });

// ---------------------------------------------------------------- detection

test('a face match on another person surfaces as a duplicate candidate', async (t) => {
  const store = createStore(await createSqliteAdapter(':memory:'));
  t.after(() => store.close());
  const matcher = fakeMatcher();

  const { person } = await store.findOrCreatePerson('Juan Carlos Pérez');
  const update = await store.addUpdate(person.id, { status: 'missing', source: 'web' });
  const photo = await store.addPhoto({
    personId: person.id,
    kind: 'report',
    updateId: update.id,
    content: Buffer.from('foto'),
    contentType: 'image/jpeg'
  });
  const { faceId } = await matcher.indexFace();
  await store.setPhotoFaceId(photo.id, faceId);

  // Someone reports the same face under a completely different name.
  const found = await findDuplicateCandidates(store, matcher, {
    name: 'Persona Sin Identificar',
    photos: [Buffer.from('otra foto')]
  });

  assert.equal(found.length, 1);
  assert.equal(found[0].person.id, person.id);
  assert.equal(found[0].reason, 'face');
  assert.equal(found[0].similarity, 97);
});

// Regression: only files[0] used to be searched, so a family whose first photo
// is an unusable group shot got no face signal at all.
test('every uploaded photo is searched, not just the first', async (t) => {
  const store = createStore(await createSqliteAdapter(':memory:'));
  t.after(() => store.close());
  const matcher = fakeMatcher({ blindTo: ['grupal'] });

  const { person } = await store.findOrCreatePerson('Juan Carlos Pérez');
  const photo = await store.addPhoto({
    personId: person.id,
    kind: 'report',
    content: Buffer.from('foto'),
    contentType: 'image/jpeg'
  });
  const { faceId } = await matcher.indexFace();
  await store.setPhotoFaceId(photo.id, faceId);

  const found = await findDuplicateCandidates(store, matcher, {
    name: 'Persona Sin Identificar',
    photos: [Buffer.from('grupal'), Buffer.from('retrato')]
  });

  assert.deepEqual(matcher.searched, ['grupal', 'retrato'], 'ambas fotos deben buscarse');
  assert.equal(found.length, 1, 'el retrato #2 debe encontrar el duplicado');
});

test("a rescuer's face is never reported as a duplicate report", async (t) => {
  const store = createStore(await createSqliteAdapter(':memory:'));
  t.after(() => store.close());
  const matcher = fakeMatcher();

  // 'query' = a rescuer holding this person. That is a MATCH, not a duplicate
  // report, and it must never show up on the warning.
  const { person } = await store.findOrCreatePerson('Persona Rescatada abc123');
  const photo = await store.addPhoto({
    personId: person.id,
    kind: 'query',
    content: Buffer.alloc(0),
    contentType: 'image/jpeg'
  });
  const { faceId } = await matcher.indexFace();
  await store.setPhotoFaceId(photo.id, faceId);

  const found = await findDuplicateCandidates(store, matcher, {
    name: 'Alguien Más',
    photos: [Buffer.from('foto')]
  });
  assert.deepEqual(found, []);
});

// The web caller runs detection BEFORE the report is written, so anything that
// escapes this function discards a report — the one outcome an emergency
// service must never produce.
test('detection never throws, whatever fails underneath', async (t) => {
  const store = createStore(await createSqliteAdapter(':memory:'));
  t.after(() => store.close());

  const brokenMatcher = {
    enabled: true,
    async searchByImage() {
      throw new Error('Rekognition caído');
    }
  };
  assert.deepEqual(
    await findDuplicateCandidates(store, brokenMatcher, {
      name: 'Nadie Registrado Aún',
      photos: [Buffer.from('foto')]
    }),
    []
  );

  // And when the DATABASE is the thing that fails.
  const brokenStore = {
    async searchPeople() {
      throw new Error('conexión perdida');
    },
    async photosByFaceIds() {
      throw new Error('conexión perdida');
    }
  };
  assert.deepEqual(
    await findDuplicateCandidates(brokenStore, nullMatcher, {
      name: 'Nadie',
      photos: [Buffer.from('foto')]
    }),
    []
  );
});

test('a report is still saved when duplicate detection is broken', async (t) => {
  const { server, base, store } = await startApp({
    enabled: true,
    async searchByImage() {
      throw new Error('Rekognition caído');
    },
    async indexFace() {
      return { faceId: null, geometry: null };
    },
    async detectFace() {
      return null;
    },
    async thumbnails() {
      return {};
    }
  });
  t.after(() => server.close());

  const res = await post(base, reportForm({ name: 'Ana Lucía Bermúdez' }));
  assert.equal(res.status, 303, 'el reporte no puede perderse porque falle la detección');
  assert.equal((await store.searchPeople('Ana Lucía Bermúdez')).length, 1);
});

// ------------------------------------------------------------- the web flow

test('a duplicate is never rejected, and the answer is always a redirect', async (t) => {
  const { server, base } = await startApp(fakeMatcher());
  t.after(() => server.close());

  await post(base, reportForm({ name: 'Juan Carlos Pérez' }));
  const second = await post(base, reportForm({ name: 'Ana Sofía Molina', contact: '311 999 8888' }));

  // 303, never a page rendered onto the POST: this handler stores photos and
  // pays for a face index per photo, so a reload of its response would
  // manufacture the very duplicate being warned about.
  assert.equal(second.status, 303);
  const location = second.headers.get('location');
  assert.match(location, /^\/person\/\d+\?reported=1&dup=\d+$/, location);

  // Both reports exist. Nothing was discarded to avoid a duplicate.
  const home = await (await fetch(base)).text();
  assert.match(home, /Juan Carlos Pérez/);
  assert.match(home, /Ana Sofía Molina/);

  // Following the redirect shows the warning and links the other report.
  const page = await (await fetch(base + location)).text();
  assert.match(page, /Puede que esta persona ya estuviera reportada/);
  assert.match(page, /Juan Carlos Pérez/);
  assert.match(page, /podría ser de la misma persona/);
});

test('a report filed under an existing name is appended, and the reporter is told', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const first = await post(base, reportForm({ name: 'Pedro Pablo Ramírez' }));
  const second = await post(
    base,
    reportForm({ name: 'Pedro Pablo Ramírez', contact: 'otra@familia.com' })
  );

  // Same record, so the same redirect target — flagged as a name collision.
  assert.equal(second.headers.get('location').split('?')[0], first.headers.get('location').split('?')[0]);
  assert.match(second.headers.get('location'), /mismo_nombre=1/);

  const page = await (await fetch(base + second.headers.get('location'))).text();
  assert.match(page, /Ya había un reporte con este mismo nombre/);
  // The dangerous case is namesakes, and the page must say what to do about it.
  assert.match(page, /dos personas distintas con el mismo nombre/);
  assert.match(page, /a@torrenegra\.com/);
});

// Regression: `reportPhotoByPerson` orders derivative-bearing photos first, so
// the photo the reporter JUST uploaded could win and be shown back to them as
// "the report that already existed" — guaranteeing a wrong answer.
test('the pre-existing photo is the one offered for comparison, not the new one', async (t) => {
  const { server, base, store } = await startApp();
  t.after(() => server.close());

  await post(base, reportForm({ name: 'Pedro Pablo Ramírez', photos: ['vieja'] }));
  const person = (await store.searchPeople('Pedro Pablo Ramírez'))[0];
  const priorPhoto = (await store.reportPhotoByPerson([person.id])).get(person.id);

  const second = await post(
    base,
    reportForm({ name: 'Pedro Pablo Ramírez', contact: 'otra@familia.com', photos: ['nueva'] })
  );
  const offered = Number(/foto_previa=(\d+)/.exec(second.headers.get('location'))[1]);

  assert.equal(offered, priorPhoto.id, 'debe ofrecer la foto que ya estaba, no la recién subida');
  const stored = await store.getPhoto(offered);
  assert.equal(Buffer.from(stored.content).toString(), 'vieja');
});

test('the duplicate warning never prints a match score taken from the URL', async (t) => {
  const { server, base, store } = await startApp();
  t.after(() => server.close());

  await post(base, reportForm({ name: 'Juan Carlos Pérez' }));
  await post(base, reportForm({ name: 'Ana Sofía Molina' }));
  const [juan] = await store.searchPeople('Juan Carlos Pérez');
  const [ana] = await store.searchPeople('Ana Sofía Molina');

  // Anyone can edit these ids, so a crafted link must not be able to assert an
  // identity match the server never made.
  const page = await (await fetch(`${base}/person/${ana.id}?dup=${juan.id}`)).text();
  assert.match(page, /Juan Carlos Pérez/);
  assert.match(page, /podría ser de la misma persona/, 'el aviso dice solo "mira este otro reporte"');
  // No claim of a measured match — the server made none for this request.
  assert.doesNotMatch(page, /coincide en un/);
  assert.doesNotMatch(page, /de coincidencia/);
});

test('a candidate whose photo cannot be rendered is not asked to be compared', async (t) => {
  const { server, base, store } = await startApp();
  t.after(() => server.close());

  // A report stored without a thumbnail: `facePlate` renders nothing for it.
  await post(base, reportForm({ name: 'Juan Carlos Pérez' }));
  await post(base, reportForm({ name: 'Ana Sofía Molina' }));
  const [juan] = await store.searchPeople('Juan Carlos Pérez');
  const [ana] = await store.searchPeople('Ana Sofía Molina');

  const page = await (await fetch(`${base}/person/${ana.id}?dup=${juan.id}`)).text();
  assert.match(page, /no tiene foto para comparar/);
  assert.doesNotMatch(page, /Compara las fotos/, 'no se pide comparar una foto que no se dibuja');
});

// The merge/split routes were removed: they mutated public records behind a
// cookie whose value the site itself hands to any stranger who re-uploads a
// public report photo (/rescate prints `contact` on a face match). Detection
// warns; reconciling is done out of band until it has a real authorization.
test('there are no endpoints that mutate or delete a person record', async (t) => {
  const { server, base, store } = await startApp();
  t.after(() => server.close());

  await post(base, reportForm({ name: 'Pedro Pablo Ramírez' }));
  const before = (await store.searchPeople('Pedro Pablo Ramírez')).length;

  for (const path of ['/report/unir', '/report/separar', '/report/merge', '/report/split']) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        cookie: 'encontrados_reporter=300 123 4567'
      },
      body: new URLSearchParams({ updateId: '1', to: '2' })
    });
    assert.equal(res.status, 404, `${path} no debería existir`);
  }

  assert.equal((await store.searchPeople('Pedro Pablo Ramírez')).length, before);
  assert.equal(typeof store.mergePeople, 'undefined');
  assert.equal(typeof store.splitUpdateToNewPerson, 'undefined');
});

// ---------------------------------------------------------------------- API

test('the API warns about duplicates and still writes the report', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const call = (body) =>
    fetch(`${base}/api/updates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

  const first = await (await call({ name: 'Juan Carlos Pérez', status: 'missing' })).json();
  assert.equal(first.person_created, true);
  assert.equal(first.duplicate.merged_into_existing_person, false);
  assert.equal(first.duplicate.warning, null);

  const again = await call({ name: 'Juan Carlos Pérez', status: 'missing', location: 'Chocó' });
  assert.equal(again.status, 201, 'un duplicado nunca se rechaza');
  const body = await again.json();
  assert.equal(body.person_created, false);
  assert.equal(body.duplicate.merged_into_existing_person, true);
  assert.match(body.duplicate.warning, /Ya existía una persona con este nombre/);
  // The report itself landed on the existing record.
  const person = await (await fetch(`${base}/api/people/${body.person_id}`)).json();
  assert.equal(person.updates.length, 2);
});

test('the API reports a near-miss name as a weak candidate, not a merge', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  await fetch(`${base}/api/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Juan Carlos Pérez Gómez', status: 'missing' })
  });
  // Scores 0.832 against the name above: inside the "worth asking about" band
  // (>= 0.6) but below findOrCreatePerson's 0.85 auto-merge.
  const res = await fetch(`${base}/api/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Juan C. Peres', status: 'missing' })
  });
  const body = await res.json();

  // Two distinct records — the names were close but not close enough to merge.
  assert.equal(body.person_created, true);
  assert.equal(body.duplicate.merged_into_existing_person, false);
  assert.equal(body.duplicate.candidates.length, 1);
  assert.equal(body.duplicate.candidates[0].reason, 'name');
  assert.match(body.duplicate.candidates[0].url, /\/person\/\d+$/);
  assert.match(body.duplicate.warning, /nombre muy parecido/);
});
