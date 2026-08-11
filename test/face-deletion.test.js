const test = require('node:test');
const assert = require('node:assert');
const env = require('../src/env');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { nullMatcher } = require('../src/faces');

// Borrar una persona tiene que llevarse las DOS copias de su rastro: la fila
// (que se va en cascada) y su firma facial, que vive en la colección de
// Rekognition y a la que la cascada no llega. Estas pruebas fijan la segunda.

const KEY = 'secreta-de-prueba';

// Anota cada llamada para poder afirmar QUÉ se retiró, no solo que se llamó.
// `broken` simula un Rekognition caído en el peor momento posible.
function deletingMatcher({ broken = false } = {}) {
  return {
    enabled: true,
    deleteCalls: [],
    async indexFace() {
      return { faceId: null, geometry: null };
    },
    async detectFace() {
      return null;
    },
    async searchByImage() {
      return [];
    },
    async deleteFaces(faceIds) {
      this.deleteCalls.push([...faceIds]);
      if (broken) throw new Error('Rekognition no responde');
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

// Una persona reportada con sus fotos ya indexadas. Se arma por el store y no
// por HTTP a propósito: lo que se prueba acá es el borrado, no la subida.
async function reportedWithFaces(store, name, faceIds) {
  const { person } = await store.findOrCreatePerson(name);
  const update = await store.addUpdate(person.id, { status: 'missing', source: 'api' });
  for (const faceId of faceIds) {
    const photo = await store.addPhoto({
      personId: person.id,
      kind: 'report',
      updateId: update.id,
      content: Buffer.from(faceId),
      contentType: 'image/jpeg'
    });
    await store.setPhotoFaceId(photo.id, faceId);
  }
  return person;
}

const del = (base, id) =>
  fetch(`${base}/api/people/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${KEY}` }
  });

test('borrar una persona retira sus firmas faciales de la colección', async (t) => {
  const matcher = deletingMatcher();
  const { server, base, store } = await startApp(matcher);
  t.after(() => {
    server.close();
    env.API_KEY = '';
  });
  env.API_KEY = KEY;

  const person = await reportedWithFaces(store, 'Juan Pérez', ['face-juan-1', 'face-juan-2']);

  const res = await del(base, person.id);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.deepEqual(matcher.deleteCalls.flat().sort(), ['face-juan-1', 'face-juan-2']);
  assert.equal(body.faces.total, 2);
  assert.equal(body.faces.deleted, 2);
  assert.deepEqual(body.faces.unconfirmed, []);

  // Y la ficha, como siempre.
  assert.equal((await fetch(`${base}/api/people/${person.id}`)).status, 404);
});

test('las firmas de otra persona no se tocan', async (t) => {
  const matcher = deletingMatcher();
  const { server, base, store } = await startApp(matcher);
  t.after(() => {
    server.close();
    env.API_KEY = '';
  });
  env.API_KEY = KEY;

  const borrada = await reportedWithFaces(store, 'Ana Gómez', ['face-ana']);
  const otra = await reportedWithFaces(store, 'Luis Rojas', ['face-luis']);

  await del(base, borrada.id);

  assert.deepEqual(matcher.deleteCalls.flat(), ['face-ana']);
  // La otra sigue en pie, con su firma intacta.
  assert.deepEqual(await store.faceIdsForPerson(otra.id), ['face-luis']);
  assert.equal((await fetch(`${base}/api/people/${otra.id}`)).status, 200);
});

test('si Rekognition falla, la persona se borra igual y las firmas quedan reportadas', async (t) => {
  const matcher = deletingMatcher({ broken: true });
  const { server, base, store } = await startApp(matcher);
  t.after(() => {
    server.close();
    env.API_KEY = '';
  });
  env.API_KEY = KEY;

  const person = await reportedWithFaces(store, 'Marta Díaz', ['face-marta']);

  const res = await del(base, person.id);
  // El borrado que promete la política de privacidad no puede quedar
  // bloqueado porque un proveedor externo esté caído.
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal((await fetch(`${base}/api/people/${person.id}`)).status, 404);

  // Pero tampoco puede quedar en silencio: la respuesta es el único rastro que
  // queda, porque los ids se fueron con las filas en la cascada.
  assert.equal(body.faces.deleted, 0);
  assert.deepEqual(body.faces.unconfirmed, ['face-marta']);
});

test('sin reconocimiento facial la respuesta lo dice en vez de callarlo', async (t) => {
  const { server, base, store } = await startApp(nullMatcher);
  t.after(() => {
    server.close();
    env.API_KEY = '';
  });
  env.API_KEY = KEY;

  const person = await reportedWithFaces(store, 'Pedro Salas', ['face-pedro']);

  const body = await (await del(base, person.id)).json();
  assert.equal(body.ok, true);
  assert.equal(body.faces.face_matching, false);
  assert.equal(body.faces.deleted, 0);
  assert.deepEqual(body.faces.unconfirmed, ['face-pedro']);
});

test('una persona sin fotos indexadas no gasta una llamada a la colección', async (t) => {
  const matcher = deletingMatcher();
  const { server, base, store } = await startApp(matcher);
  t.after(() => {
    server.close();
    env.API_KEY = '';
  });
  env.API_KEY = KEY;

  const person = await reportedWithFaces(store, 'Sin Fotos', []);

  const body = await (await del(base, person.id)).json();
  assert.equal(body.ok, true);
  assert.equal(body.faces.total, 0);
  assert.deepEqual(matcher.deleteCalls, []);
});
