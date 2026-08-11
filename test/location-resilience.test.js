const test = require('node:test');
const assert = require('node:assert');
const { LOCATION_SCRIPT } = require('../src/html');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { nullMatcher } = require('../src/faces');

// Bug: '📍 Compartir mi ubicación actual' used to hide the (required)
// `location` field before the reverse-geocode call to Nominatim resolved.
// On bad signal — the exact scenario this product must survive — that call
// can fail or time out, leaving `location` empty and hidden. The form still
// submits, the server rejects it (400, `!location.trim()`), and the whole
// report — photos, name, contact — is silently discarded.
//
// Fix: prefill `location.value` with the raw GPS coordinates synchronously,
// before the Nominatim fetch even starts. The fetch is now only allowed to
// IMPROVE that text, never to be the sole source of it.

test('LOCATION_SCRIPT prefills location with the GPS fallback BEFORE calling Nominatim', () => {
  const prefillIdx = LOCATION_SCRIPT.indexOf("loc.value = 'Ubicación GPS compartida");
  const fetchIdx = LOCATION_SCRIPT.indexOf('nominatim.openstreetmap.org/reverse');
  assert.ok(prefillIdx !== -1, 'no encontré el prellenado de ubicación GPS en LOCATION_SCRIPT');
  assert.ok(fetchIdx !== -1, 'no encontré la llamada a Nominatim en LOCATION_SCRIPT');
  assert.ok(
    prefillIdx < fetchIdx,
    'el prellenado de location.value debe ocurrir ANTES de la llamada a Nominatim, no depender de su resultado'
  );
});

test('LOCATION_SCRIPT only improves the prefilled text on a successful geocode, never sets it from scratch', () => {
  // Inside the .then(function (d) { ... }) callback, the assignment must be
  // gated on `d.display_name` (i.e. a successful response), not unconditional.
  const thenBlock = LOCATION_SCRIPT.slice(
    LOCATION_SCRIPT.indexOf('nominatim.openstreetmap.org/reverse')
  );
  assert.match(
    thenBlock,
    /if \(d\.display_name && loc\) \{\s*loc\.value = d\.display_name/,
    'la mejora del texto debe seguir condicionada al éxito del geocode inverso'
  );
});

// End-to-end: simulate what the FIXED client sends when Nominatim is down —
// `location` already carries the GPS fallback text instead of arriving
// empty. Confirms the server path accepts it and the report is not lost.
test('a report submitted with the GPS fallback location text is accepted, not discarded', async (t) => {
  const app = await createApp(await createSqliteAdapter(':memory:'), nullMatcher);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  const fd = new FormData();
  fd.set('name', 'Ana Lucía Bermúdez');
  // Exactly the fallback text LOCATION_SCRIPT now writes when the reverse
  // geocode never resolves.
  fd.set('location', 'Ubicación GPS compartida (4.6097, -74.0817)');
  fd.set('lat', '4.6097');
  fd.set('lng', '-74.0817');
  fd.set('contact', '300 111 2222');
  fd.append('photos', new File([Buffer.from('foto')], 'f.jpg', { type: 'image/jpeg' }));

  const res = await fetch(`${base}/report`, { method: 'POST', body: fd, redirect: 'manual' });
  assert.equal(res.status, 303, 'el reporte con la ubicación de respaldo GPS no debe descartarse');

  const home = await (await fetch(base)).text();
  assert.match(home, /Ana Lucía Bermúdez/, 'el reporte debe existir: nada se perdió');
});
