// GET /admin/stats — el panel de estadísticas (#116, PR 6).
//
// Lo que estos tests protegen: que la vista NO filtre PII en su HTML
// renderizado (mismo patrón que los tests anteriores, ahora sobre HTML en
// vez de JSON); que sin PUBLIC_STATS la vista exige sesión (cerrado por
// omisión); que /api/admin/* — el hogar de un futuro drill-down — exige
// sesión SIEMPRE, con y sin el flag; y que las cifras del panel coinciden
// con las que produce gatherReportData, la misma función que usa el correo.
const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const env = require('../src/env');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { gatherReportData } = require('../src/report');

function fakeMatcher() {
  const indexed = new Map();
  let n = 0;
  const key = (b) => b.toString('utf8');
  return {
    enabled: true,
    status: 'activo (fake)',
    async indexFace(bytes) {
      const id = `face-${++n}`;
      if (!indexed.has(key(bytes))) indexed.set(key(bytes), []);
      indexed.get(key(bytes)).push(id);
      return { faceId: id, geometry: null };
    },
    async detectFace() {
      return null;
    },
    async searchByImage(bytes) {
      return (indexed.get(key(bytes)) || []).map((faceId) => ({ faceId, similarity: 97 }));
    },
    // computeMatchStats no es el foco de este archivo (ya lo cubre
    // test/match-stats.test.js) — alcanza con que no reviente y deje el
    // embudo en 0.
    async searchByFaceId() {
      return [];
    }
  };
}

async function photoBytes(label) {
  let h = 0;
  for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) % 16777216;
  return sharp({
    create: { width: 200, height: 250, channels: 3, background: { r: (h >> 16) & 255, g: (h >> 8) & 255, b: h & 255 } }
  })
    .jpeg()
    .toBuffer();
}

async function startApp(matcher) {
  const app = await createApp(await createSqliteAdapter(':memory:'), matcher || fakeMatcher());
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}`, store: app.locals.store, matcher: app.locals.matcher };
}

async function reportMissing(base, { name, contact, face }) {
  const fd = new FormData();
  fd.set('name', name);
  fd.set('location', 'Barrio San José');
  fd.set('contact', contact);
  fd.append('photos', new File([await photoBytes(face)], 'f.jpg', { type: 'image/jpeg' }));
  return fetch(`${base}/report`, { method: 'POST', body: fd, redirect: 'manual' });
}

function cleanupEnv() {
  delete process.env.PUBLIC_STATS;
  delete process.env.ADMIN_SESSION_SECRET;
  delete process.env.ADMIN_EMAILS;
  env.API_KEY = '';
}

test('sin PUBLIC_STATS, GET /admin/stats exige sesión — cerrado por omisión', async (t) => {
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    cleanupEnv();
  });

  const res = await fetch(`${base}/admin/stats`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /^\/admin\/login/);
});

test('con PUBLIC_STATS=1, GET /admin/stats responde sin sesión — con noindex y el banner', async (t) => {
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    cleanupEnv();
  });
  process.env.PUBLIC_STATS = '1';

  const res = await fetch(`${base}/admin/stats`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');

  const html = await res.text();
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(html, /Vista temporal sin autenticación/);
  assert.match(html, /issues\/116/);
});

test('cualquier valor de PUBLIC_STATS distinto de "1" deja la vista cerrada', async (t) => {
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    cleanupEnv();
  });
  process.env.PUBLIC_STATS = 'true'; // no es '1' — sigue cerrado

  const res = await fetch(`${base}/admin/stats`, { redirect: 'manual' });
  assert.equal(res.status, 302);
});

test('/api/admin/* exige sesión SIEMPRE — con y sin PUBLIC_STATS activo', async (t) => {
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    cleanupEnv();
  });

  const closedRes = await fetch(`${base}/api/admin/cualquier-cosa`, { redirect: 'manual' });
  assert.equal(closedRes.status, 302, 'sin PUBLIC_STATS, /api/admin/* pide sesión');

  process.env.PUBLIC_STATS = '1';
  const withFlagRes = await fetch(`${base}/api/admin/cualquier-cosa`, { redirect: 'manual' });
  assert.equal(withFlagRes.status, 302, 'PUBLIC_STATS abre /admin/stats, NUNCA /api/admin/* — el drill-down no tiene puerta "mientras tanto"');
});

test('el panel público no filtra nada de lo sembrado — solo cifras agregadas, como /api/diag', async (t) => {
  const matcher = fakeMatcher();
  const { server, base } = await startApp(matcher);
  t.after(() => {
    server.close();
    cleanupEnv();
  });
  process.env.PUBLIC_STATS = '1';

  await reportMissing(base, {
    name: 'Fernanda Prueba Rios',
    contact: 'familia-fernanda@ejemplo.com · 300 555 1212',
    face: 'fernanda'
  });
  // Un "rescate" con la misma cara — genera un match_log real, superficie rescate.
  const fd = new FormData();
  fd.set('photo', new File([await photoBytes('fernanda')], 'r.jpg', { type: 'image/jpeg' }));
  fd.set('email', 'rescatista-fernanda@ejemplo.com');
  await fetch(`${base}/rescate`, { method: 'POST', body: fd });

  const html = await (await fetch(`${base}/admin/stats`)).text();
  // 'face-1' es el id sintético que este fakeMatcher le puso a la firma
  // indexada — el chequeo real. El substring genérico "face-" NO sirve: la
  // clase CSS .face-noscript del script de miniaturas (src/html.js, en TODA
  // página vía layout()) da un falso positivo que no tiene nada que ver con
  // face_id.
  for (const leak of [
    'Fernanda',
    'Rios',
    'familia-fernanda',
    '300 555 1212',
    'rescatista-fernanda',
    'face-1',
    'person_id',
    'update_id'
  ]) {
    assert.ok(!html.includes(leak), `el panel no debe contener "${leak}"`);
  }
});

test('las cifras del panel coinciden con gatherReportData — la misma fuente que usa el correo', async (t) => {
  const matcher = fakeMatcher();
  const { server, base, store } = await startApp(matcher);
  t.after(() => {
    server.close();
    cleanupEnv();
  });
  process.env.PUBLIC_STATS = '1';

  await reportMissing(base, { name: 'Gustavo Prueba Panel', contact: 'gustavo@ejemplo.com', face: 'gustavo' });
  const fd = new FormData();
  fd.set('photo', new File([await photoBytes('gustavo')], 'r.jpg', { type: 'image/jpeg' }));
  fd.set('email', 'rescatista@ejemplo.com');
  await fetch(`${base}/rescate`, { method: 'POST', body: fd });

  // La MISMA función que arma el correo — no una consulta distinta que
  // pueda divergir.
  const data = await gatherReportData(store, matcher);
  assert.ok(data.activity.match.total >= 1, 'debía haber al menos una coincidencia registrada para comparar algo real');

  const html = await (await fetch(`${base}/admin/stats`)).text();
  assert.match(html, new RegExp(`<strong>${data.activity.match.total}</strong>`), 'el total de coincidencias del panel debe ser el mismo número que gatherReportData');
});
