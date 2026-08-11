const test = require('node:test');
const assert = require('node:assert');
const { createSqliteAdapter } = require('../src/store/sqlite');
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

async function seedPerson(base, overrides = {}) {
  const res = await fetch(`${base}/api/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'María Fernanda López',
      status: 'missing',
      location: 'Armenia',
      reporter: 'Su hermana',
      contact: '301 555 0000',
      ...overrides
    })
  });
  assert.equal(res.status, 201);
  return res.json();
}

test('web: la home ofrece el buscador por nombre', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const html = await (await fetch(base)).text();
  assert.match(html, /action="\/buscar"/);
  assert.match(html, /name="q"/);
});

test('web: /buscar encuentra con typos y sin tildes, y enlaza la ficha', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());
  const created = await seedPerson(base);

  // Misspelled, missing accents, incomplete — the whole point of the fuzzy matcher.
  const res = await fetch(`${base}/buscar?q=${encodeURIComponent('maria lopes')}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /María Fernanda López/);
  assert.match(html, new RegExp(`href="/person/${created.person_id}"`));
  // The status of the latest update shows next to the name.
  assert.match(html, /Desaparecid/i);
});

test('web: /buscar nunca muestra contacto ni reportero', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());
  await seedPerson(base);

  const html = await (await fetch(`${base}/buscar?q=maria`)).text();
  assert.doesNotMatch(html, /301 555 0000/);
  assert.doesNotMatch(html, /Su hermana/);
});

test('web: /buscar sin resultados invita a reportar', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const html = await (await fetch(`${base}/buscar?q=zzzz+qqqq`)).text();
  assert.match(html, /No encontramos a nadie/);
  assert.match(html, /href="\/report"/);
});

test('web: /buscar sin q redirige a la home', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const res = await fetch(`${base}/buscar`, { redirect: 'manual' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
});

test('web: /buscar escapa el término — nada de HTML inyectado', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const evil = '<script>alert(1)</script>';
  const html = await (await fetch(`${base}/buscar?q=${encodeURIComponent(evil)}`)).text();
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});
