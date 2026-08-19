const test = require('node:test');
const assert = require('node:assert');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { fakeVercelOAuth } = require('./helpers');

// #161: un admin retira la firma facial de una persona SIN borrar su ficha —
// a pedido de una familia que ya la encontró. A diferencia de
// test/face-deletion.test.js (#114), acá la persona se queda: lo que fijan
// estas pruebas es que la firma sale de Rekognition, que la foto NO se vuelve
// a indexar sola, que el archivo de la foto queda intacto (las dos reglas de
// fotos son opuestas a propósito — la del reporte SÍ se publica), y que la
// acción deja constancia en `privacy_actions` para Ley 1581.

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

// Extrae los pares nombre=valor de una respuesta con varios Set-Cookie, y los
// arma de vuelta como header Cookie — no hay cookie jar en fetch de Node.
// Mismo helper que test/admin-auth.test.js (no exportado desde ahí: cada
// archivo de prueba en este repo arma su propio fixture).
function cookieHeaderFrom(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  return raw.map((c) => c.split(';')[0]).join('; ');
}

// No hay atajo para obtener una sesión de /admin: sin correrlo entero,
// requireAdminSession no la va a aceptar (por diseño — ver test/admin-auth.test.js).
async function adminSessionCookies(base, oauth, email) {
  oauth.setUserInfo({ email, email_verified: true });
  const startRes = await fetch(`${base}/admin/login/start`, { redirect: 'manual' });
  const transient = cookieHeaderFrom(startRes);
  const state = new URL(startRes.headers.get('location')).searchParams.get('state');
  const callbackRes = await fetch(`${base}/admin/auth/callback?code=fake-code&state=${state}`, {
    redirect: 'manual',
    headers: { Cookie: transient }
  });
  return cookieHeaderFrom(callbackRes);
}

const ADMIN_EMAIL = 'admin.prueba@ejemplo.com';

function withAdminEnv(t) {
  process.env.ADMIN_SESSION_SECRET = 'secreto-de-prueba-largo-y-aleatorio';
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  t.after(() => {
    delete process.env.ADMIN_SESSION_SECRET;
    delete process.env.ADMIN_EMAILS;
  });
}

// Una persona ya "safe" con sus fotos de REPORTE ya indexadas — el caso real
// del issue: la familia avisó, y ahora quiere que deje de ser encontrable.
async function safeWithFaces(store, name, faceIds) {
  const { person } = await store.findOrCreatePerson(name);
  const update = await store.addUpdate(person.id, { status: 'safe', source: 'api' });
  const photos = [];
  for (const faceId of faceIds) {
    const photo = await store.addPhoto({
      personId: person.id,
      kind: 'report',
      updateId: update.id,
      content: Buffer.from(`bytes-${faceId}`),
      contentType: 'image/jpeg'
    });
    await store.setPhotoFaceId(photo.id, faceId);
    photos.push(photo);
  }
  return { person, photos };
}

const forgetFace = (base, cookies, id) =>
  fetch(`${base}/api/admin/people/${id}/forget-face`, {
    method: 'POST',
    headers: { Cookie: cookies }
  });

test('un admin retira la firma facial sin borrar la ficha', async (t) => {
  const matcher = deletingMatcher();
  const oauth = await fakeVercelOAuth();
  const { server, base, store } = await startApp(matcher);
  t.after(() => {
    server.close();
    oauth.stop();
  });
  withAdminEnv(t);
  const cookies = await adminSessionCookies(base, oauth, ADMIN_EMAIL);

  const { person } = await safeWithFaces(store, 'Persona Prueba Uno', ['face-uno']);

  const res = await forgetFace(base, cookies, person.id);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.deepEqual(matcher.deleteCalls.flat(), ['face-uno']);
  assert.equal(body.faces.deleted, 1);
  assert.ok(body.action.id);
  // La constancia lleva el resultado real: un retiro completo se anota como
  // 0 firmas sin confirmar, no solo "la acción se pidió".
  assert.equal(body.action.unconfirmed_count, 0);

  // La ficha sigue viva — a diferencia de DELETE /api/people/:id.
  assert.equal((await fetch(`${base}/api/people/${person.id}`)).status, 200);
});

test('la fila no vuelve a indexarse sola', async (t) => {
  const matcher = deletingMatcher();
  const oauth = await fakeVercelOAuth();
  const { server, base, store } = await startApp(matcher);
  t.after(() => {
    server.close();
    oauth.stop();
  });
  withAdminEnv(t);
  const cookies = await adminSessionCookies(base, oauth, ADMIN_EMAIL);

  const { person } = await safeWithFaces(store, 'Persona Prueba Dos', ['face-dos']);
  await forgetFace(base, cookies, person.id);

  // El face_id se queda con el valor viejo — ya no existe en la colección,
  // pero sigue NOT NULL en la fila. Es justo lo que hace que
  // photosMissingFaceId (la consulta detrás de backfillUnindexedPhotos) no la
  // vuelva a recoger: si se hubiera puesto en null, el próximo barrido la
  // reindexaría solo y deshacía en silencio lo que se le prometió a la familia.
  assert.deepEqual(await store.faceIdsForPerson(person.id), ['face-dos']);
  const pendientes = await store.photosMissingFaceId(100);
  assert.ok(
    !pendientes.some((p) => p.person_id === person.id),
    'la foto retirada no debe aparecer como pendiente de indexar'
  );
});

test('el archivo de la foto sigue disponible — solo se retira la firma', async (t) => {
  const matcher = deletingMatcher();
  const oauth = await fakeVercelOAuth();
  const { server, base, store } = await startApp(matcher);
  t.after(() => {
    server.close();
    oauth.stop();
  });
  withAdminEnv(t);
  const cookies = await adminSessionCookies(base, oauth, ADMIN_EMAIL);

  const { person, photos } = await safeWithFaces(store, 'Persona Prueba Tres', ['face-tres']);
  await forgetFace(base, cookies, person.id);

  const photoRes = await fetch(`${base}/photo/${photos[0].id}`);
  assert.equal(photoRes.status, 200);
  assert.equal(await photoRes.text(), 'bytes-face-tres');
});

test('persona inexistente: 404 y no toca la colección ni deja constancia', async (t) => {
  const matcher = deletingMatcher();
  const oauth = await fakeVercelOAuth();
  const { server, base, store } = await startApp(matcher);
  t.after(() => {
    server.close();
    oauth.stop();
  });
  withAdminEnv(t);
  const cookies = await adminSessionCookies(base, oauth, ADMIN_EMAIL);

  const res = await forgetFace(base, cookies, 999999);
  assert.equal(res.status, 404);
  assert.deepEqual(matcher.deleteCalls, []);
});

test('sin firmas indexadas, igual queda la constancia pero no gasta una llamada a la colección', async (t) => {
  const matcher = deletingMatcher();
  const oauth = await fakeVercelOAuth();
  const { server, base, store } = await startApp(matcher);
  t.after(() => {
    server.close();
    oauth.stop();
  });
  withAdminEnv(t);
  const cookies = await adminSessionCookies(base, oauth, ADMIN_EMAIL);

  const { person } = await safeWithFaces(store, 'Persona Prueba Cuatro', []);

  const res = await forgetFace(base, cookies, person.id);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.faces.total, 0);
  assert.deepEqual(matcher.deleteCalls, []);
  assert.ok(body.action.id, 'la constancia se registra aunque no hubiera nada que retirar');
});

test('si Rekognition falla, la constancia anota el resultado real, no que se cumplió', async (t) => {
  const matcher = deletingMatcher({ broken: true });
  const oauth = await fakeVercelOAuth();
  const { server, base, store } = await startApp(matcher);
  t.after(() => {
    server.close();
    oauth.stop();
  });
  withAdminEnv(t);
  const cookies = await adminSessionCookies(base, oauth, ADMIN_EMAIL);

  const { person } = await safeWithFaces(store, 'Persona Prueba Cinco', ['face-cinco']);

  const res = await forgetFace(base, cookies, person.id);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.faces.unconfirmed, ['face-cinco']);
  assert.ok(body.action.id, 'la acción se registra aunque Rekognition no responda');
  // Sin esto la fila diría "se retiró la firma" aunque quedó indexada — el
  // registro permanente (para Ley 1581) tiene que poder distinguir un retiro
  // completo de uno que no se pudo confirmar.
  assert.equal(body.action.unconfirmed_count, 1);

  const [accion] = await store.privacyActionsForPerson(person.id);
  assert.equal(accion.unconfirmed_count, 1, 'la fila persistida también debe cargar el resultado real');
});

test('sin sesión de admin, el endpoint redirige al login — mismo gate que el resto de /api/admin', async (t) => {
  const matcher = deletingMatcher();
  const { server, base, store } = await startApp(matcher);
  t.after(() => server.close());

  const { person } = await safeWithFaces(store, 'Persona Prueba Seis', ['face-seis']);

  const res = await fetch(`${base}/api/admin/people/${person.id}/forget-face`, {
    method: 'POST',
    redirect: 'manual'
  });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /^\/admin\/login/);
  assert.deepEqual(matcher.deleteCalls, []);
});

test('la constancia anota qué admin la ejecutó', async (t) => {
  const matcher = deletingMatcher();
  const oauth = await fakeVercelOAuth();
  const { server, base, store } = await startApp(matcher);
  t.after(() => {
    server.close();
    oauth.stop();
  });
  withAdminEnv(t);
  const cookies = await adminSessionCookies(base, oauth, ADMIN_EMAIL);

  const { person } = await safeWithFaces(store, 'Persona Prueba Siete', ['face-siete']);
  await forgetFace(base, cookies, person.id);

  const [accion] = await store.privacyActionsForPerson(person.id);
  assert.ok(accion, 'debía quedar una fila en privacy_actions');
  assert.equal(accion.action, 'forget_face');
  assert.equal(accion.actor, ADMIN_EMAIL);
  assert.ok(accion.created_at);
});
