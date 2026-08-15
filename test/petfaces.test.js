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
