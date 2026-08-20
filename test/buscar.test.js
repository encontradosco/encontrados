const test = require('node:test');
const assert = require('node:assert');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createStore } = require('../src/people');
const { createApp } = require('../src/server');
const { nullMatcher } = require('../src/faces');

async function startApp() {
  const app = await createApp(await createSqliteAdapter(':memory:'), nullMatcher);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

async function seedPerson(base, { name, status, location, contact, reporter }) {
  const res = await fetch(`${base}/api/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      status,
      location,
      contact,
      reporter,
      message: 'Nota de prueba'
    })
  });
  assert.equal(res.status, 201);
  return res.json();
}

test('/buscar: search hits do not use the home stretched card-link', async (t) => {
  // I2: results must not use `card person` + `card-link`, or #65's overlay
  // steals taps from the hybrid CTAs. Layout lives on `.card.search-hit` alone.
  const { server, base } = await startApp();
  t.after(() => server.close());

  await seedPerson(base, {
    name: 'Persona Prueba Card',
    status: 'missing',
    location: 'Barrio Prueba',
    contact: '300 000 0001',
    reporter: 'Familiar Prueba'
  });
  const html = await (await fetch(`${base}/buscar?q=Persona+Prueba+Card`)).text();
  assert.match(html, /class="card search-hit"/);
  assert.doesNotMatch(html, /class="card person search-hit"/);
  assert.doesNotMatch(html, /class="card-link"/);
  assert.match(html, /class="search-actions"/);
});

test('latestUpdateByPerson matches getLatestUpdate and skips aggregator-only safe', async (t) => {
  const store = createStore(await createSqliteAdapter(':memory:'));
  const { person: a } = await store.findOrCreatePerson('Persona Prueba Batch A');
  const { person: b } = await store.findOrCreatePerson('Persona Prueba Batch B');
  await store.addUpdate(a.id, { status: 'missing', source: 'web', location: 'Lugar A' });
  await store.addUpdate(b.id, { status: 'missing', source: 'web', location: 'Lugar B' });
  await store.addUpdate(b.id, { status: 'safe', source: 'aggregator', message: 'Localizada' });

  const batch = await store.latestUpdateByPerson([a.id, b.id]);
  assert.equal(batch.get(a.id).status, 'missing');
  assert.equal(batch.get(a.id).location, 'Lugar A');
  assert.equal(batch.get(b.id).status, 'missing', 'aggregator safe no gana como latest');
  assert.equal(batch.get(b.id).status, (await store.getLatestUpdate(b.id)).status);
  assert.equal(batch.size, 2);
});

test('/buscar: empty form and optional entry points', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const page = await (await fetch(`${base}/buscar`)).text();
  assert.match(page, /¿Ya está reportada o reencontrada\?/);
  assert.match(page, /action="\/buscar"/);
  assert.match(page, /name="q"/);
  assert.match(page, /Ir directo a reportar/);

  const home = await (await fetch(base)).text();
  assert.match(home, /href="\/buscar"/);
  assert.match(home, /Búscala primero/);

  const report = await (await fetch(`${base}/report`)).text();
  assert.match(report, /href="\/buscar"/);
  assert.match(report, /Búscala primero/);
});

test('/buscar: finds missing and reunited people with hybrid CTAs', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const missing = await seedPerson(base, {
    name: 'Persona Prueba Buscada',
    status: 'missing',
    location: 'Barrio Centro',
    contact: '300 111 2222',
    reporter: 'Familiar Prueba'
  });
  const safe = await seedPerson(base, {
    name: 'Persona Prueba Reencontrada',
    status: 'safe',
    location: 'Hospital Prueba',
    contact: '300 333 4444',
    reporter: '573009998877'
  });

  const missingHtml = await (await fetch(`${base}/buscar?q=Persona+Prueba+Buscada`)).text();
  assert.match(missingHtml, /Persona Prueba Buscada/);
  assert.match(missingHtml, /DESAPARECIDO/);
  assert.match(missingHtml, /Barrio Centro/);
  assert.match(
    missingHtml,
    new RegExp(`/report\\?name=${encodeURIComponent('Persona Prueba Buscada')}&desde=${missing.person_id}`)
  );
  assert.match(missingHtml, /Yo la estoy buscando — dejar mi contacto/);
  assert.match(missingHtml, /Reportar de todas formas/);
  // Privacy: family contact and raw phone-as-reporter never appear.
  assert.doesNotMatch(missingHtml, /300 111 2222/);

  const safeHtml = await (await fetch(`${base}/buscar?q=Persona+Prueba+Reencontrada`)).text();
  assert.match(safeHtml, /Persona Prueba Reencontrada/);
  assert.match(safeHtml, /A SALVO/);
  assert.match(safeHtml, new RegExp(`href="/person/${safe.person_id}"`));
  assert.match(safeHtml, /Ver ficha/);
  assert.match(safeHtml, /No es esta persona — reportar a otra/);
  assert.doesNotMatch(safeHtml, /300 333 4444/);
  assert.doesNotMatch(safeHtml, /573009998877/);
});

test('/buscar: deceased and injured put the ficha first', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const deceased = await seedPerson(base, {
    name: 'Persona Prueba Fallecida',
    status: 'deceased',
    location: 'Lugar Prueba',
    contact: '300 555 6666',
    reporter: 'Familiar Prueba Dos'
  });
  const injured = await seedPerson(base, {
    name: 'Persona Prueba Herida',
    status: 'injured',
    location: 'Hospital Prueba Dos',
    contact: '300 777 8888',
    reporter: 'Familiar Prueba Tres'
  });

  const deceasedHtml = await (await fetch(`${base}/buscar?q=Persona+Prueba+Fallecida`)).text();
  assert.match(deceasedHtml, /FALLECIDO/);
  assert.match(deceasedHtml, new RegExp(`href="/person/${deceased.person_id}"`));
  assert.match(deceasedHtml, /Ver ficha/);
  assert.match(deceasedHtml, /No es esta persona — reportar a otra/);
  assert.doesNotMatch(
    deceasedHtml,
    /Yo la estoy buscando — dejar mi contacto/,
    'fallecida: no invitar a dejar contacto como si siguiera desaparecida'
  );
  assert.doesNotMatch(deceasedHtml, /300 555 6666/);

  const injuredHtml = await (await fetch(`${base}/buscar?q=Persona+Prueba+Herida`)).text();
  assert.match(injuredHtml, /HERIDO/);
  assert.match(injuredHtml, /Ver ficha/);
  assert.match(
    injuredHtml,
    new RegExp(`/report\\?name=${encodeURIComponent('Persona Prueba Herida')}&desde=${injured.person_id}`)
  );
  assert.match(injuredHtml, /Yo la estoy buscando — dejar mi contacto/);
  assert.doesNotMatch(injuredHtml, /300 777 8888/);
});

test('/buscar: no matches still offers reporting', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const html = await (await fetch(`${base}/buscar?q=Nombre+Que+No+Existe+XYZ`)).text();
  assert.match(html, /No encontramos a nadie/);
  assert.match(html, /Reportarla ahora/);
  assert.match(html, /name=Nombre%20Que%20No%20Existe%20XYZ/);
});
