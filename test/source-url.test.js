// source_url: el enlace a la noticia que confirma que una persona apareció.
//
// Lo que se prueba acá no es "se guarda un campo". Es que un `safe` con enlace
// llegue hasta la ficha que lee alguien buscando a un familiar, y que ese
// enlace no pueda ser cualquier cosa: termina siendo un href clickeable en la
// página más frágil del sitio.
//
// Datos 100 % sintéticos, como el resto de la suite.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSqliteAdapter } = require('../src/store/sqlite');
const { createStore } = require('../src/people');
const { createApp } = require('../src/server');
const { nullMatcher } = require('../src/faces');

// Mismo arranque que el resto de la suite: cada archivo levanta su propia app
// en memoria para no compartir estado entre pruebas.
async function startApp() {
  const app = await createApp(await createSqliteAdapter(':memory:'), nullMatcher);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}`, store: app.locals.store };
}

test('POST /api/updates guarda source_url y lo devuelve en la ficha', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());
  process.env.API_KEY = 'test-key';
  t.after(() => { delete process.env.API_KEY; });

  const res = await fetch(`${app.base}/api/updates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
    body: JSON.stringify({
      name: 'Persona Prueba Enlace',
      status: 'safe',
      source: 'aggregator',
      source_url: 'https://ejemplo.com/noticia/rescatados-chocó'
    })
  });
  assert.equal(res.status, 201);

  const { person } = await app.store.findOrCreatePerson('Persona Prueba Enlace');
  const html = await (await fetch(`${app.base}/person/${person.id}`)).text();

  assert.match(html, /Encontrado — ver noticia/, 'la ficha debe ofrecer el enlace a la noticia');
  assert.match(html, /ejemplo\.com\/noticia/, 'el href debe apuntar a la noticia');
});

test('un update sin source_url no inventa ningún enlace', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());

  const { person } = await app.store.findOrCreatePerson('Persona Prueba Sin Enlace');
  await app.store.addUpdate(person.id, { status: 'missing', source: 'web', location: 'Quibdó' });

  const html = await (await fetch(`${app.base}/person/${person.id}`)).text();
  assert.doesNotMatch(html, /source-link/, 'sin enlace no debe renderizarse el bloque');
});

test('source_url solo acepta http(s): un javascript: se descarta sin tumbar el reporte', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());
  process.env.API_KEY = 'test-key';
  t.after(() => { delete process.env.API_KEY; });

  // El caso que importa: alguien con la API key manda un esquema peligroso.
  // El reporte tiene que entrar igual — perder el aviso de que una persona
  // apareció por culpa de un enlace malo sería peor que ignorar el enlace.
  for (const hostile of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'no-soy-una-url']) {
    const res = await fetch(`${app.base}/api/updates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
      body: JSON.stringify({
        name: 'Persona Prueba Hostil',
        status: 'safe',
        source: 'aggregator',
        source_url: hostile
      })
    });
    assert.equal(res.status, 201, `el reporte debe entrar igual con source_url=${hostile}`);
  }

  const { person } = await app.store.findOrCreatePerson('Persona Prueba Hostil');
  const html = await (await fetch(`${app.base}/person/${person.id}`)).text();

  assert.doesNotMatch(html, /javascript:/, 'nunca debe salir un href javascript:');
  assert.doesNotMatch(html, /data:text\/html/, 'nunca debe salir un href data:');
  assert.doesNotMatch(html, /source-link/, 'un enlace descartado no debe renderizar el bloque');
});

test('un re-push con el mismo external_id refresca el enlace', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());
  process.env.API_KEY = 'test-key';
  t.after(() => { delete process.env.API_KEY; });

  const post = (sourceUrl) =>
    fetch(`${app.base}/api/updates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
      body: JSON.stringify({
        name: 'Persona Prueba Idempotente',
        status: 'safe',
        source: 'aggregator',
        external_id: 'ctb-9999',
        source_url: sourceUrl
      })
    });

  await post('https://ejemplo.com/nota-vieja');
  await post('https://ejemplo.com/nota-corregida');

  const { person } = await app.store.findOrCreatePerson('Persona Prueba Idempotente');
  const html = await (await fetch(`${app.base}/person/${person.id}`)).text();

  assert.match(html, /nota-corregida/, 'el re-push debe actualizar el enlace');
  assert.doesNotMatch(html, /nota-vieja/, 'el enlace viejo no debe sobrevivir');
});
