const test = require('node:test');
const assert = require('node:assert');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createStore } = require('../src/people');
const { createApp } = require('../src/server');
const { nullMatcher } = require('../src/faces');
const { findDuplicateCandidates } = require('../src/duplicates');

// A matcher that reports every photo as the same face, so the face path can be
// exercised without AWS. `searchByImage` answers with whatever face ids have
// been indexed so far — exactly the shape Rekognition returns.
function fakeMatcher() {
  let next = 1;
  const indexed = [];
  return {
    enabled: true,
    status: 'fake',
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
    async searchByImage() {
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

function reportForm({ name, location = 'Barrio Centro', contact = '300 123 4567' }) {
  const fd = new FormData();
  fd.set('name', name);
  fd.set('location', location);
  fd.set('contact', contact);
  fd.append('photos', new File([Buffer.from('foto')], 'f.jpg', { type: 'image/jpeg' }));
  return fd;
}

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
    photoBytes: Buffer.from('otra foto')
  });

  assert.equal(found.length, 1);
  assert.equal(found[0].person.id, person.id);
  assert.equal(found[0].reason, 'face');
  assert.equal(found[0].similarity, 97);
});

test("a rescuer's face is never reported as a duplicate report", async (t) => {
  const store = createStore(await createSqliteAdapter(':memory:'));
  t.after(() => store.close());
  const matcher = fakeMatcher();

  // 'query' = a rescuer holding this person. That is a MATCH, not a duplicate
  // report, and it must never show up on the reconciliation screen.
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
    photoBytes: Buffer.from('foto')
  });
  assert.deepEqual(found, []);
});

test('a face-matching provider that is down never breaks detection', async (t) => {
  const store = createStore(await createSqliteAdapter(':memory:'));
  t.after(() => store.close());
  const broken = {
    enabled: true,
    async searchByImage() {
      throw new Error('Rekognition caído');
    }
  };
  // No throw, no candidates — reporting keeps working.
  const found = await findDuplicateCandidates(store, broken, {
    name: 'Nadie Registrado Aún',
    photoBytes: Buffer.from('foto')
  });
  assert.deepEqual(found, []);
});

// ------------------------------------------------------------- the web flow

test('a duplicate is never rejected: the report is saved before anything is asked', async (t) => {
  const { server, base, store } = await startApp(fakeMatcher());
  t.after(() => server.close());

  await fetch(`${base}/report`, { method: 'POST', body: reportForm({ name: 'Juan Carlos Pérez' }) });
  const second = await fetch(`${base}/report`, {
    method: 'POST',
    body: reportForm({ name: 'Ana Sofía Molina', contact: '311 999 8888' })
  });

  // 200 with the reconciliation screen, NOT a redirect and NOT an error.
  assert.equal(second.status, 200);
  const html = await second.text();
  assert.match(html, /Reporte registrado/);
  assert.match(html, /Puede que esta persona ya estuviera reportada/);
  assert.match(html, /La foto coincide en un <strong>97%<\/strong>/);

  // Both reports exist. Nothing was discarded to avoid a duplicate.
  const home = await (await fetch(base)).text();
  assert.match(home, /Juan Carlos Pérez/);
  assert.match(home, /Ana Sofía Molina/);
});

test('a report filed under an existing name is appended, and the reporter is told', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  await fetch(`${base}/report`, { method: 'POST', body: reportForm({ name: 'Pedro Pablo Ramírez' }) });
  const second = await fetch(`${base}/report`, {
    method: 'POST',
    body: reportForm({ name: 'Pedro Pablo Ramírez', contact: 'otra@familia.com' })
  });

  assert.equal(second.status, 200);
  const html = await second.text();
  assert.match(html, /Ya había un reporte con este mismo nombre/);
  // Both answers are offered, and neither is a dead end.
  assert.match(html, /Sí, es la misma/);
  assert.match(html, /No, es otra persona/);
  assert.match(html, /action="\/report\/separar"/);
});

test('"es otra persona" splits the report onto its own record', async (t) => {
  const { server, base, store } = await startApp();
  t.after(() => server.close());

  await fetch(`${base}/report`, { method: 'POST', body: reportForm({ name: 'Pedro Pablo Ramírez' }) });
  const second = await fetch(`${base}/report`, {
    method: 'POST',
    body: reportForm({ name: 'Pedro Pablo Ramírez', contact: 'otra@familia.com' })
  });
  const cookie = second.headers
    .getSetCookie()
    .find((c) => c.startsWith('encontrados_reporter='))
    .split(';')[0];
  const updateId = /name="updateId" value="(\d+)"/.exec(await second.text())[1];

  assert.equal((await store.searchPeople('Pedro Pablo Ramírez', { limit: 5 })).length, 1);

  const split = await fetch(`${base}/report/separar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ updateId }),
    redirect: 'manual'
  });
  assert.equal(split.status, 303);

  // Two people now, each holding one report — the namesakes are untangled.
  const people = await store.searchPeople('Pedro Pablo Ramírez', { limit: 5 });
  assert.equal(people.length, 2);
  for (const p of people) {
    assert.equal((await store.getUpdates(p.id)).length, 1);
  }
});

test('"es la misma persona" merges the two records without losing a report', async (t) => {
  const { server, base, store } = await startApp(fakeMatcher());
  t.after(() => server.close());

  await fetch(`${base}/report`, {
    method: 'POST',
    body: reportForm({ name: 'Juan Carlos Pérez', contact: 'papa@ejemplo.com' })
  });
  const second = await fetch(`${base}/report`, {
    method: 'POST',
    body: reportForm({ name: 'Ana Sofía Molina', contact: 'hermana@ejemplo.com' })
  });
  const cookie = second.headers
    .getSetCookie()
    .find((c) => c.startsWith('encontrados_reporter='))
    .split(';')[0];
  const html = await second.text();
  const updateId = /name="updateId" value="(\d+)"/.exec(html)[1];
  const to = /name="to" value="(\d+)"/.exec(html)[1];

  const merged = await fetch(`${base}/report/unir`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ updateId, to }),
    redirect: 'manual'
  });
  assert.equal(merged.status, 303);
  assert.equal(merged.headers.get('location'), `/person/${to}?unido=1`);

  // One record, BOTH reports on it — so a rescuer sees both families' contacts.
  const updates = await store.getUpdates(to);
  assert.equal(updates.length, 2);
  assert.deepEqual(
    updates.map((u) => u.contact).sort(),
    ['hermana@ejemplo.com', 'papa@ejemplo.com']
  );
  assert.equal(await store.getPerson((await store.searchPeople('Ana Sofía Molina'))[0]?.id), undefined);
});

test('merging and splitting are refused to anyone but the reporter', async (t) => {
  const { server, base, store } = await startApp();
  t.after(() => server.close());

  await fetch(`${base}/report`, { method: 'POST', body: reportForm({ name: 'Pedro Pablo Ramírez' }) });
  const second = await fetch(`${base}/report`, {
    method: 'POST',
    body: reportForm({ name: 'Pedro Pablo Ramírez', contact: 'otra@familia.com' })
  });
  const updateId = /name="updateId" value="(\d+)"/.exec(await second.text())[1];

  // No cookie at all, and a cookie belonging to somebody else's report.
  for (const headers of [
    { 'Content-Type': 'application/x-www-form-urlencoded' },
    { 'Content-Type': 'application/x-www-form-urlencoded', cookie: 'encontrados_reporter=impostor@ejemplo.com' }
  ]) {
    for (const path of ['/report/separar', '/report/unir']) {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers,
        body: new URLSearchParams({ updateId, to: '1' })
      });
      assert.equal(res.status, 403, `${path} no debería aceptar a un tercero`);
    }
  }

  // Nothing moved.
  assert.equal((await store.searchPeople('Pedro Pablo Ramírez', { limit: 5 })).length, 1);
});

// ---------------------------------------------------------------------- API

test('the API warns about duplicates and still writes the report', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const post = (body) =>
    fetch(`${base}/api/updates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

  const first = await (await post({ name: 'Juan Carlos Pérez', status: 'missing' })).json();
  assert.equal(first.person_created, true);
  assert.equal(first.duplicate.merged_into_existing_person, false);
  assert.equal(first.duplicate.warning, null);

  const again = await post({ name: 'Juan Carlos Pérez', status: 'missing', location: 'Chocó' });
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
