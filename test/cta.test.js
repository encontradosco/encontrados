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

async function seedMissing(base, name) {
  const res = await fetch(`${base}/api/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, status: 'missing', location: 'Centro' })
  });
  assert.equal(res.status, 201);
  return res.json();
}

// #65: a rescuer scanning the listing acts from the card itself — the CTA is
// on every card, the whole card links to the ficha, and each CTA names its
// person so a screen reader can tell twenty of them apart.
test('#65: cada card del listado trae el CTA de rescatista y el enlace a la ficha', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());
  const created = await seedMissing(base, 'Carmen Julia Ríos');

  const home = await (await fetch(base)).text();
  assert.match(home, /class="card-cta" href="\/rescate"/);
  assert.match(home, /¿La tienes contigo\?/);
  assert.match(home, new RegExp(`class="card-link" href="/person/${created.person_id}"`));
  assert.match(home, /aria-label="¿Tienes contigo a Carmen Julia Ríos\?/);
});

// #65: on a long ficha the action used to live below the whole timeline;
// now it rides in a sticky container so it is reachable without scrolling.
test('#65: la ficha lleva el CTA en un contenedor sticky', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());
  const created = await seedMissing(base, 'Jorge Iván Mora');

  const page = await (await fetch(`${base}/person/${created.person_id}`)).text();
  assert.match(page, /class="sticky-cta"><a class="big-btn report" href="\/rescate"/);
});
