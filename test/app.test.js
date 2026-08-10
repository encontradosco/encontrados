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

test('API: report, fuzzy search, person detail, subscription', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const post = await fetch(`${base}/api/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'María Fernanda López',
      status: 'safe',
      message: 'Confirmado por su hermana',
      location: 'Cali',
      reporter: 'Hermana'
    })
  });
  assert.equal(post.status, 201);
  const created = await post.json();
  assert.equal(created.person_created, true);

  const search = await fetch(`${base}/api/people?q=maria lopez`);
  const { results } = await search.json();
  assert.equal(results.length, 1);
  assert.equal(results[0].latest_update.status, 'safe');

  const detail = await fetch(`${base}/api/people/${results[0].id}`);
  const person = await detail.json();
  assert.equal(person.updates.length, 1);
  assert.equal(person.updates[0].location, 'Cali');

  const sub = await fetch(`${base}/api/people/${results[0].id}/subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'email', address: 'Familia@Ejemplo.com' })
  });
  assert.equal(sub.status, 201);
});

test('API: validation errors', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const noName = await fetch(`${base}/api/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'safe' })
  });
  assert.equal(noName.status, 400);

  const badStatus = await fetch(`${base}/api/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'X Y', status: 'vivo' })
  });
  assert.equal(badStatus.status, 400);
});

test('web: home renders, report form flow works', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const home = await fetch(base);
  assert.equal(home.status, 200);
  const homeHtml = await home.text();
  assert.match(homeHtml, /Reportar estado de alguien/);
  assert.match(homeHtml, /Buscar a alguien/);
  assert.match(homeHtml, /Terremoto en Colombia/);

  const buscar = await fetch(`${base}/buscar`);
  assert.match(await buscar.text(), /¿Buscas a alguien\?/);

  // A photo is mandatory on the web report form.
  const fd = new FormData();
  fd.set('name', 'Pedro Pablo Ramírez');
  fd.set('status', 'missing');
  fd.set('message', 'No contesta desde ayer');
  fd.set('location', 'Barrio Centro');
  fd.set('photo', new File([Buffer.from('foto')], 'f.jpg', { type: 'image/jpeg' }));
  const report = await fetch(`${base}/report`, { method: 'POST', body: fd, redirect: 'manual' });
  assert.equal(report.status, 303);
  const personUrl = report.headers.get('location');

  const page = await fetch(`${base}${personUrl}`);
  const html = await page.text();
  assert.match(html, /Pedro Pablo Ramírez/);
  assert.match(html, /DESAPARECIDO/);
  assert.match(html, /Última ubicación reportada/);
});

test('webhook: whatsapp inbound message is processed', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const res = await fetch(`${base}/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { type: 'text', from: '573000000000', text: { body: 'BIEN Laura Díaz' } }
                ]
              }
            }
          ]
        }
      ]
    })
  });
  assert.equal(res.status, 200);
  // give the async handler a beat to persist
  await new Promise((r) => setTimeout(r, 150));
  const search = await fetch(`${base}/api/people?q=laura diaz`);
  const { results } = await search.json();
  assert.equal(results.length, 1);
  assert.equal(results[0].latest_update.status, 'safe');
  assert.equal(results[0].latest_update.source, 'whatsapp');
});

test('purge-test-data removes only the seeded test records', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());
  const store = (await (async () => null)()) || null;

  const mk = (name) =>
    fetch(`${base}/api/updates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, status: 'safe' })
    });
  await mk('Verificacion Final');
  await mk('Cadena Completa 9147');
  await mk('Nicolas Contreras'); // a real report must survive

  const res = await fetch(`${base}/api/maintenance/purge-test-data`, { method: 'POST' });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.removed_count >= 2, JSON.stringify(body));

  const survivors = await (await fetch(`${base}/api/people?q=Nicolas Contreras`)).json();
  assert.equal(survivors.results.length, 1, 'un reporte real fue borrado');

  const gone = await (await fetch(`${base}/api/people?q=Verificacion Final`)).json();
  assert.equal(gone.results.length, 0);
});

test('DELETE /api/people/:id is disabled without API_KEY', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());
  const res = await fetch(`${base}/api/people/1`, { method: 'DELETE' });
  assert.equal(res.status, 503);
});

test('reporter and email are remembered between visits via cookies', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const fd = new FormData();
  fd.set('name', 'Marta Isabel Vélez');
  fd.set('status', 'safe');
  fd.set('reporter', 'Cruz Roja · 300 555 1234');
  fd.set('photo', new File([Buffer.from('foto')], 'f.jpg', { type: 'image/jpeg' }));
  const res = await fetch(`${base}/report`, { method: 'POST', body: fd, redirect: 'manual' });
  assert.equal(res.status, 303);

  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('aqui_reporter='));
  assert.ok(cookie, 'no se guardó la cookie del reportante');

  // Next report prefills who is reporting.
  const form = await fetch(`${base}/report`, { headers: { cookie: cookie.split(';')[0] } });
  assert.match(await form.text(), /Cruz Roja · 300 555 1234/);
});

test('the report form no longer offers self-reporting', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());
  const html = await (await fetch(`${base}/report`)).text();
  assert.doesNotMatch(html, /Me reporto a m/);
  assert.doesNotMatch(html, /name="subject"/);
  // photo is required and comes before the name
  assert.ok(html.indexOf('name="photo"') < html.indexOf('name="name"'), 'la foto debe ir antes del nombre');
  assert.match(html, /name="photo"[^>]*required/);
});
