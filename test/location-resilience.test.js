const test = require('node:test');
const assert = require('node:assert');
const { LOCATION_SCRIPT } = require('../src/html');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { nullMatcher } = require('../src/faces');

// The '📍 Compartir mi ubicación actual' button was removed from the report
// form: on bad signal its reverse-geocode step used to fail in ways that
// could cost the whole report. The typed-address flow (with the Nominatim
// autocomplete) is now the only client path, and the server must keep
// accepting whatever text the reporter provides.

test('the report form no longer offers the GPS button', async (t) => {
  const app = await createApp(await createSqliteAdapter(':memory:'), nullMatcher);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  const html = await (await fetch(`${base}/report`)).text();
  assert.ok(!html.includes('Compartir mi ubicación actual'), 'el botón de GPS debe estar retirado');
  assert.ok(!LOCATION_SCRIPT.includes('geo-btn'), 'LOCATION_SCRIPT no debe cargar código muerto del botón GPS');
  assert.doesNotMatch(html, /navigator\.geolocation/, 'ningún script de la página debe pedir el GPS');
  // The location field itself stays: it is how the report says WHERE.
  assert.match(html, /name="location"/);
  // The address autocomplete stays: it is how people type the location now.
  assert.ok(LOCATION_SCRIPT.includes('nominatim.openstreetmap.org/search'));
});

// End-to-end: a report whose location is plain text (including the GPS
// fallback wording older clients may still send) is accepted, not discarded.
test('a report submitted with the GPS fallback location text is accepted, not discarded', async (t) => {
  const app = await createApp(await createSqliteAdapter(':memory:'), nullMatcher);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  const fd = new FormData();
  fd.set('name', 'Ana Lucía Bermúdez');
  fd.set('location', 'Ubicación GPS compartida (4.609700, -74.081700)');
  fd.set('lat', '4.6097');
  fd.set('lng', '-74.0817');
  fd.set('contact', '300 111 2222');
  fd.append('photos', new File([Buffer.from('foto')], 'f.jpg', { type: 'image/jpeg' }));

  const res = await fetch(`${base}/report`, { method: 'POST', body: fd, redirect: 'manual' });
  assert.equal(res.status, 303, 'el reporte con la ubicación de respaldo GPS no debe descartarse');

  const home = await (await fetch(base)).text();
  assert.match(home, /Ana Lucía Bermúdez/, 'el reporte debe existir: nada se perdió');
});
