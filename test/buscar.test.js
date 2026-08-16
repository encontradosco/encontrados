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

test('/buscar: search-actions sit above the stretched card-link overlay', async (t) => {
  // Regression for B1: without z-index on .search-actions, the home card's
  // stretched .card-link::after steals taps meant for the hybrid CTAs.
  const css = require('fs').readFileSync(require('path').join(__dirname, '../public/styles.css'), 'utf8');
  assert.match(
    css,
    /\.card\.person\s+\.search-actions\s*\{[^}]*z-index:\s*1/s,
    '.search-actions must be listed with the #65 overlay exceptions'
  );
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
  assert.match(safeHtml, /No es ella — reportar a otra persona/);
  assert.doesNotMatch(safeHtml, /300 333 4444/);
  assert.doesNotMatch(safeHtml, /573009998877/);
});

test('/buscar: no matches still offers reporting', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const html = await (await fetch(`${base}/buscar?q=Nombre+Que+No+Existe+XYZ`)).text();
  assert.match(html, /No encontramos a nadie/);
  assert.match(html, /Reportarla ahora/);
  assert.match(html, /name=Nombre%20Que%20No%20Existe%20XYZ/);
});
