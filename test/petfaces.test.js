const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

async function fakePetMatcherServer(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('sin PET_MATCH_API_URL, el matcher queda deshabilitado y embed() devuelve null', async () => {
  delete process.env.PET_MATCH_API_URL;
  const { createPetMatcher } = require('../src/petfaces');
  const matcher = createPetMatcher();
  assert.equal(matcher.enabled, false);
  assert.equal(await matcher.embed(Buffer.from('x'), 'image/jpeg'), null);
});

test('con la URL puesta, embed() llama al servicio y devuelve el vector', async () => {
  const { server, base } = await fakePetMatcherServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ embedding: [0.1, 0.2], model: 'modelo-fake' }));
  });
  process.env.PET_MATCH_API_URL = base;
  const { createPetMatcher } = require('../src/petfaces');
  const matcher = createPetMatcher();
  assert.equal(matcher.enabled, true);
  const result = await matcher.embed(Buffer.from('foto'), 'image/jpeg');
  assert.deepEqual(result, { embedding: [0.1, 0.2], model: 'modelo-fake' });
  server.close();
  delete process.env.PET_MATCH_API_URL;
});

test('el status del matcher activo nunca repite la URL del servicio (sin auth, /api/diag es público)', async () => {
  const { server, base } = await fakePetMatcherServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ embedding: [0.1, 0.2], model: 'modelo-fake' }));
  });
  process.env.PET_MATCH_API_URL = base;
  const { createPetMatcher } = require('../src/petfaces');
  const matcher = createPetMatcher();
  assert.equal(matcher.status, 'activo');
  assert.ok(!matcher.status.includes(base), 'el status no debe filtrar la dirección del servicio');
  server.close();
  delete process.env.PET_MATCH_API_URL;
});

test('un 200 sin un embedding válido (servicio mal configurado) devuelve null, no basura', async () => {
  const { server, base } = await fakePetMatcherServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Un 200 real, pero de otro servicio cualquiera — sin la forma esperada.
    res.end(JSON.stringify({ ok: true }));
  });
  process.env.PET_MATCH_API_URL = base;
  const { createPetMatcher } = require('../src/petfaces');
  const matcher = createPetMatcher();
  const result = await matcher.embed(Buffer.from('foto'), 'image/jpeg');
  assert.equal(result, null, 'sin un array de embedding, debe fallar limpio en vez de guardar undefined/undefined');
  server.close();
  delete process.env.PET_MATCH_API_URL;
});

test('si el servicio responde con error, embed() devuelve null sin lanzar', async () => {
  const { server, base } = await fakePetMatcherServer((req, res) => {
    res.writeHead(500).end('boom');
  });
  process.env.PET_MATCH_API_URL = base;
  const { createPetMatcher } = require('../src/petfaces');
  const matcher = createPetMatcher();
  assert.equal(await matcher.embed(Buffer.from('foto'), 'image/jpeg'), null);
  server.close();
  delete process.env.PET_MATCH_API_URL;
});

test('si el servicio no responde (nadie escuchando), embed() devuelve null sin lanzar', async () => {
  process.env.PET_MATCH_API_URL = 'http://127.0.0.1:1';
  const { createPetMatcher } = require('../src/petfaces');
  const matcher = createPetMatcher();
  assert.equal(await matcher.embed(Buffer.from('foto'), 'image/jpeg'), null);
  delete process.env.PET_MATCH_API_URL;
});

test('con PET_MATCH_SHARED_SECRET puesto, embed() manda el secreto en el header', async () => {
  let recibido;
  const { server, base } = await fakePetMatcherServer((req, res) => {
    recibido = req.headers['x-pet-matcher-secret'];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ embedding: [0.1, 0.2], model: 'modelo-fake' }));
  });
  process.env.PET_MATCH_API_URL = base;
  process.env.PET_MATCH_SHARED_SECRET = 'secreto-de-prueba';
  const { createPetMatcher } = require('../src/petfaces');
  const matcher = createPetMatcher();
  await matcher.embed(Buffer.from('foto'), 'image/jpeg');
  assert.equal(recibido, 'secreto-de-prueba');
  server.close();
  delete process.env.PET_MATCH_API_URL;
  delete process.env.PET_MATCH_SHARED_SECRET;
});

test('sin PET_MATCH_SHARED_SECRET, embed() no manda el header (mismo comportamiento de siempre)', async () => {
  let recibido = 'sin-tocar';
  const { server, base } = await fakePetMatcherServer((req, res) => {
    recibido = req.headers['x-pet-matcher-secret'];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ embedding: [0.1, 0.2], model: 'modelo-fake' }));
  });
  process.env.PET_MATCH_API_URL = base;
  delete process.env.PET_MATCH_SHARED_SECRET;
  const { createPetMatcher } = require('../src/petfaces');
  const matcher = createPetMatcher();
  await matcher.embed(Buffer.from('foto'), 'image/jpeg');
  assert.equal(recibido, undefined);
  server.close();
  delete process.env.PET_MATCH_API_URL;
});

test('si el servicio acepta la conexión pero no responde, embed() devuelve null sin colgarse', async () => {
  const { server, base } = await fakePetMatcherServer((req, res) => {
    // No responder — simula un servicio colgado o sobrecargado
  });
  process.env.PET_MATCH_API_URL = base;
  const { createPetMatcher } = require('../src/petfaces');
  const matcher = createPetMatcher(500); // 500ms timeout para el test
  const start = Date.now();
  const result = await matcher.embed(Buffer.from('foto'), 'image/jpeg');
  const elapsed = Date.now() - start;
  assert.equal(result, null);
  assert.ok(elapsed < 2000, `No debería tomar más de 2s, tomó ${elapsed}ms`);
  server.close();
  delete process.env.PET_MATCH_API_URL;
});
