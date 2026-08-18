// Borrar una ficha a solicitud de la persona tiene que DURAR (#191).
//
// El defecto que fijan estas pruebas: el ON CONFLICT (external_id) de
// insertUpdate es lo que hace idempotente a un re-envío, y necesita que la fila
// exista. Borrada la ficha, un re-envío de la misma no actualizaba nada:
// insertaba de nuevo, con la cara reindexada, sin log ni error. Para el sistema
// era una ficha nueva que entró bien.
//
// Todos los datos de acá son inventados: no hay ninguna persona real en este
// archivo, ni en un nombre ni en una llave.
const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const env = require('../src/env');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');

const KEY = 'secreta-de-prueba';
const FICHA = 'https://ejemplo.invalido/?person=00000000-0000-4000-8000-000000000001';

// Anota los indexados para poder afirmar que un re-envío NO vuelve a indexar la
// cara — que es la mitad del defecto que menos se ve, porque no deja rastro.
function countingMatcher() {
  let n = 0;
  return {
    enabled: true,
    indexCalls: [],
    deleteCalls: [],
    async indexFace(bytes) {
      n += 1;
      this.indexCalls.push(bytes.length);
      return { faceId: `cara-${n}`, geometry: null };
    },
    async detectFace() {
      return null;
    },
    async searchByImage() {
      return [];
    },
    async deleteFaces(faceIds) {
      this.deleteCalls.push([...faceIds]);
      return { deleted: [...faceIds], unconfirmed: [] };
    }
  };
}

async function startApp(matcher) {
  const app = await createApp(await createSqliteAdapter(':memory:'), matcher);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    store: app.locals.store
  };
}

async function jpeg() {
  return sharp({ create: { width: 80, height: 80, channels: 3, background: { r: 9, g: 9, b: 9 } } })
    .jpeg()
    .toBuffer();
}

const push = (base, body) =>
  fetch(`${base}/api/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body)
  });

const del = (base, id) =>
  fetch(`${base}/api/people/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${KEY}` }
  });

async function conLlave(base, extra = {}) {
  const foto = await jpeg();
  return push(base, {
    name: 'Persona Prueba Uno',
    status: 'missing',
    source: 'aggregator',
    external_id: FICHA,
    photo: { base64: foto.toString('base64'), content_type: 'image/jpeg' },
    ...extra
  });
}

test('un re-envío de la misma llave ya no revive la ficha borrada', async (t) => {
  const matcher = countingMatcher();
  const { server, base, store } = await startApp(matcher);
  t.after(() => {
    server.close();
    env.API_KEY = '';
  });
  env.API_KEY = KEY;

  const creada = await (await conLlave(base)).json();
  assert.equal(matcher.indexCalls.length, 1, 'la primera entrada sí indexa la cara');

  const borrado = await (await del(base, creada.person_id)).json();
  assert.equal(borrado.ok, true);
  assert.equal(borrado.suppressed_external_ids, 1);

  // El re-envío: mismo cuerpo, misma llave. Antes insertaba una persona nueva.
  const reenvio = await conLlave(base);
  assert.equal(reenvio.status, 409);
  const cuerpo = await reenvio.json();
  assert.equal(cuerpo.suppressed, true);
  assert.equal(cuerpo.external_id, FICHA);

  // Las tres consecuencias, que es lo que de verdad se está protegiendo.
  assert.equal((await store.counts()).people, 0, 'no debía quedar ninguna persona');
  assert.equal(matcher.indexCalls.length, 1, 'la cara NO se volvió a indexar');
  assert.equal((await fetch(`${base}/api/people/${creada.person_id}`)).status, 404);
});

test('la constancia sobrevive a la ficha — es la única tabla que no cae en cascada', async (t) => {
  const matcher = countingMatcher();
  const { server, base, store } = await startApp(matcher);
  t.after(() => {
    server.close();
    env.API_KEY = '';
  });
  env.API_KEY = KEY;

  const creada = await (await conLlave(base)).json();
  assert.equal(await store.isExternalIdSuppressed(FICHA), false);

  await del(base, creada.person_id);

  // Si suppressed_external_ids colgara de people(id), la cascada se llevaría la
  // constancia junto con la ficha y el borrado volvería a ser reversible.
  assert.equal(await store.isExternalIdSuppressed(FICHA), true);
});

test('reportar a esa persona sin llave externa sigue siendo posible', async (t) => {
  const matcher = countingMatcher();
  const { server, base, store } = await startApp(matcher);
  t.after(() => {
    server.close();
    env.API_KEY = '';
  });
  env.API_KEY = KEY;

  const creada = await (await conLlave(base)).json();
  await del(base, creada.person_id);

  // Es el límite del mecanismo y es deliberado: lo que se suprime es la
  // re-entrada automática de una ficha, no el derecho de nadie a reportar. Si
  // una familia la reporta de verdad —por el formulario, que no manda llave—
  // bloquearlo sería peor que el problema que la supresión arregla.
  const res = await push(base, { name: 'Persona Prueba Uno', status: 'missing', source: 'web' });
  assert.equal(res.status, 201);
  assert.equal((await store.counts()).people, 1);
});

test('la supresión es de UNA llave, no de un nombre ni de una fuente', async (t) => {
  const matcher = countingMatcher();
  const { server, base } = await startApp(matcher);
  t.after(() => {
    server.close();
    env.API_KEY = '';
  });
  env.API_KEY = KEY;

  const creada = await (await conLlave(base)).json();
  await del(base, creada.person_id);

  const otra = await conLlave(base, {
    external_id: 'https://ejemplo.invalido/?person=00000000-0000-4000-8000-000000000002'
  });
  assert.equal(otra.status, 201, 'otra llave es otra ficha, aunque venga del mismo agregador');
});

test('la purga de registros de prueba NO suprime la llave', async (t) => {
  const matcher = countingMatcher();
  const { server, base } = await startApp(matcher);
  t.after(() => {
    server.close();
    env.API_KEY = '';
  });
  env.API_KEY = KEY;

  // Un registro de prueba lo sembramos nosotros: nadie ejerció ningún derecho,
  // así que su llave no queda bloqueada para siempre. La diferencia entre los
  // dos borrados es de consecuencia, no de forma.
  const sembrada = await (await conLlave(base, { name: 'Prueba Entrega Correo' })).json();
  const purga = await (
    await fetch(`${base}/api/maintenance/purge-test-data`, { method: 'POST' })
  ).json();
  assert.equal(purga.removed_count, 1);
  assert.equal((await fetch(`${base}/api/people/${sembrada.person_id}`)).status, 404);

  const revuelve = await conLlave(base, { name: 'Prueba Entrega Correo' });
  assert.equal(revuelve.status, 201, 'la ficha de prueba puede volver a entrar');
});

test('borrar a alguien que nunca entró por una llave no deja constancia de nada', async (t) => {
  const matcher = countingMatcher();
  const { server, base } = await startApp(matcher);
  t.after(() => {
    server.close();
    env.API_KEY = '';
  });
  env.API_KEY = KEY;

  const creada = await (await push(base, { name: 'Persona Prueba Dos', status: 'missing', source: 'web' })).json();
  const borrado = await (await del(base, creada.person_id)).json();

  // Sin llave no hay nada por lo que la ficha pueda volver a entrar sola: una
  // fila vacía en la tabla de constancia no protegería nada y sería un dato de
  // más en la única tabla que no se borra.
  assert.equal(borrado.suppressed_external_ids, 0);
});
