const test = require('node:test');
const assert = require('node:assert');
const { LOCATION_SCRIPT } = require('../src/html');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { nullMatcher } = require('../src/faces');

// The report form used to carry a '📍 Compartir mi ubicación actual' button.
// It is gone: the reporter is almost never standing where the missing person
// was last seen, so their GPS answered a different question than the form
// asks — and it cost a browser permission prompt to get the wrong answer.
//
// Removing it also removes a whole failure mode. The button hid the (required)
// `location` field and refilled it from a reverse-geocode call to Nominatim;
// on bad signal — the exact scenario this product must survive — that call
// could fail or time out, leaving `location` empty AND hidden. The form still
// submitted, the server rejected it (400, `!location.trim()`), and the whole
// report — photos, name, contact — was silently discarded.

test('the report form never asks the browser for the reporter\'s location', async (t) => {
  const app = await createApp(await createSqliteAdapter(':memory:'), nullMatcher);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  const form = await (await fetch(`${base}/report`)).text();
  assert.doesNotMatch(form, /Compartir mi ubicación actual/);
  assert.doesNotMatch(form, /geo-btn/);
  assert.doesNotMatch(form, /navigator\.geolocation/, 'ningún script de la página debe pedir el GPS');
  // The location field itself stays: it is how the report says WHERE.
  assert.match(form, /name="location"/);
});

test('LOCATION_SCRIPT keeps the place-name autocomplete and nothing else', () => {
  assert.doesNotMatch(LOCATION_SCRIPT, /navigator\.geolocation/);
  assert.doesNotMatch(LOCATION_SCRIPT, /nominatim\.openstreetmap\.org\/reverse/);
  // Type-ahead over Colombian place names is the one thing it still does.
  assert.match(LOCATION_SCRIPT, /nominatim\.openstreetmap\.org\/search\?format=json&countrycodes=co/);
});

// The server still accepts a typed location on a weak connection: the field is
// plain text and nothing about the submit depends on a third-party fetch.
test('a report with a plain typed location is accepted, not discarded', async (t) => {
  const app = await createApp(await createSqliteAdapter(':memory:'), nullMatcher);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  const fd = new FormData();
  fd.set('name', 'Ana Lucía Bermúdez');
  fd.set('location', 'Cerca del puente, barrio San José');
  fd.set('contact', '300 111 2222');
  fd.append('photos', new File([Buffer.from('foto')], 'f.jpg', { type: 'image/jpeg' }));

  const res = await fetch(`${base}/report`, { method: 'POST', body: fd, redirect: 'manual' });
  assert.equal(res.status, 303, 'el reporte no debe descartarse');

  const home = await (await fetch(base)).text();
  assert.match(home, /Ana Lucía Bermúdez/, 'el reporte debe existir: nada se perdió');
});
