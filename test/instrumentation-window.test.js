// "Los ceros pre-instrumentación son una mentira por omisión" (hotfix
// post-#127/#128, sobre el hallazgo del panel mostrando 4 coincidencias / 0
// envíos). Lo que estos tests protegen: matchLogEarliest/contactLogEarliest
// devuelven null en una bitácora vacía y la fecha real una vez que hay
// filas; gatherDailySeries distingue "sin instrumentación" de "cero" por
// día; y el panel + el correo muestran "—" / "medido desde…" en vez de un
// cero disfrazado de dato — nunca leen como historia completa.
const test = require('node:test');
const assert = require('node:assert');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { nullMatcher } = require('../src/faces');
const { logMatch, logContact } = require('../src/logbook');
const { gatherDailySeries, gatherCheapReportData, buildReportHtml, buildReportText, bogotaDayKey } = require('../src/report');

async function startApp() {
  const app = await createApp(await createSqliteAdapter(':memory:'), nullMatcher);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}`, store: app.locals.store };
}

function cleanupEnv() {
  delete process.env.PUBLIC_STATS;
}

test('matchLogEarliest/contactLogEarliest: null en una bitácora vacía', async () => {
  const store = (await createApp(await createSqliteAdapter(':memory:'))).locals.store;
  assert.equal(await store.matchLogEarliest(), null);
  assert.equal(await store.contactLogEarliest(), null);
});

test('matchLogEarliest/contactLogEarliest: la fecha real del primer registro, no la del más reciente', async () => {
  const store = (await createApp(await createSqliteAdapter(':memory:'))).locals.store;
  const { person } = await store.findOrCreatePerson('Alguien De Prueba');

  await logMatch(store, { personId: person.id, updateId: null, faceId: 'a', similarity: 90, surface: 'rescate' });
  const afterFirst = await store.matchLogEarliest();
  assert.ok(afterFirst, 'debía quedar una fecha tras el primer registro');

  await new Promise((r) => setTimeout(r, 10));
  await logMatch(store, { personId: person.id, updateId: null, faceId: 'b', similarity: 90, surface: 'rescate' });
  const afterSecond = await store.matchLogEarliest();
  assert.equal(afterSecond, afterFirst, 'debe seguir siendo la fecha del PRIMER registro, no la del segundo');

  await logContact(store, { personId: person.id, updateId: null, channel: 'email', result: 'enviado' });
  assert.ok(await store.contactLogEarliest());
});

test('gatherDailySeries: los días antes del primer registro quedan marcados como no disponibles, no en cero', async () => {
  const store = (await createApp(await createSqliteAdapter(':memory:'))).locals.store;
  const { person } = await store.findOrCreatePerson('Alguien De Prueba');

  // Un solo match, HOY — así que todos los días anteriores de la ventana de
  // 7 no tienen ni un registro real.
  await logMatch(store, { personId: person.id, updateId: null, faceId: 'a', similarity: 90, surface: 'rescate' });

  const daily = await gatherDailySeries(store, { days: 7 });
  // Día de BOGOTÁ, no UTC — es el mismo corte que usa gatherDailySeries
  // ahora, y difieren entre las 19:00 y la medianoche Bogotá.
  const today = bogotaDayKey(new Date());
  const todayRow = daily.find((d) => d.day === today);
  const earlierRows = daily.filter((d) => d.day !== today);

  assert.ok(todayRow.matchesAvailable, 'hoy sí hay instrumentación — el match se registró hoy');
  assert.equal(todayRow.matches, 1);
  for (const row of earlierRows) {
    assert.equal(row.matchesAvailable, false, `${row.day} es anterior al primer registro — no debe estar "disponible"`);
    // El valor numérico puede seguir siendo 0 (no hay filas), pero el
    // renderizador (adminStats.js) NUNCA debe mostrarlo sin mirar el flag.
  }
});

test('el panel muestra "—" para los días sin instrumentación, nunca 0', async (t) => {
  const { server, base, store } = await startApp();
  t.after(() => {
    server.close();
    cleanupEnv();
  });
  process.env.PUBLIC_STATS = '1';

  const { person } = await store.findOrCreatePerson('Alguien De Prueba');
  await logMatch(store, { personId: person.id, updateId: null, faceId: 'a', similarity: 90, surface: 'rescate' });

  const html = await (await fetch(`${base}/admin/stats`)).text();
  // La tabla de 7 días debe traer al menos un "—" (los días anteriores a
  // hoy, que es el único día con registro real).
  assert.match(html, />—</, 'debía haber al menos una celda "—" para un día sin instrumentación');
});

test('el panel dice "medido desde" con la fecha real del primer registro', async (t) => {
  const { server, base, store } = await startApp();
  t.after(() => {
    server.close();
    cleanupEnv();
  });
  process.env.PUBLIC_STATS = '1';

  const { person } = await store.findOrCreatePerson('Alguien De Prueba');
  await logMatch(store, { personId: person.id, updateId: null, faceId: 'a', similarity: 90, surface: 'rescate' });
  await logContact(store, { personId: person.id, updateId: null, channel: 'email', result: 'enviado' });

  const html = await (await fetch(`${base}/admin/stats`)).text();
  assert.match(html, /Medido desde/);
  assert.doesNotMatch(html, /Medido desde:.*sin registros todavía.*sin registros todavía/, 'con datos reales, ninguna de las dos fechas debe decir "sin registros"');
});

test('sin ningún registro todavía, el panel lo dice explícitamente — no arma una fecha inventada', async (t) => {
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    cleanupEnv();
  });
  process.env.PUBLIC_STATS = '1';

  const html = await (await fetch(`${base}/admin/stats`)).text();
  assert.match(html, /Sin registros todavía en la bitácora/);
});

test('el correo también trae "medido desde" en HTML y texto', async () => {
  const generatedAt = new Date('2026-08-13T18:00:00Z');
  const counts = { people: 1, updates: 1, subscriptions: 0, subscriptions_verified: 0, photos: 0, photos_indexed: 0 };
  const activity = {
    match: { total: 1, rescate: 1, report: 0, api: 0 },
    contact: [],
    since: { at: new Date('2026-08-13T12:00:00Z'), match: { total: 0 }, contact: [] },
    instrumentedSince: { match: new Date('2026-08-12T22:03:00Z'), contact: null }
  };
  const html = buildReportHtml(generatedAt, counts, null, 'desconocido', activity, 0);
  const text = buildReportText(generatedAt, counts, null, 'desconocido', activity, 0);
  assert.match(html, /Medido desde/);
  assert.match(html, /12 ago, 17:03 Bogotá/); // 22:03 UTC = 17:03 Bogotá (UTC-5)
  assert.match(html, /sin registros todavía/); // contact: null
  assert.match(text, /Medido desde/);
});

test('la gráfica del embudo trae un aria-label agregado, y las gráficas no filtran nada sembrado', async (t) => {
  const matcher = {
    enabled: true,
    status: 'activo (fake)',
    async ensureReady() {},
    async searchByFaceId() {
      return [];
    }
  };
  const app = await createApp(await createSqliteAdapter(':memory:'), matcher);
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.close();
    cleanupEnv();
  });
  process.env.PUBLIC_STATS = '1';

  const { person } = await app.locals.store.findOrCreatePerson('Persona Con Nombre Real');
  await logMatch(app.locals.store, { personId: person.id, updateId: null, faceId: 'x', similarity: 90, surface: 'rescate' });

  const pageHtml = await (await fetch(`${base}/admin/stats`)).text();
  assert.match(pageHtml, /<svg role="img" aria-label="/, 'las gráficas de la página principal deben traer role=img + aria-label');
  assert.ok(!pageHtml.includes('Persona Con Nombre Real'), 'ninguna gráfica ni aria-label debe contener el nombre sembrado');

  const funnelHtml = await (await fetch(`${base}/admin/stats/funnel`)).text();
  assert.match(funnelHtml, /<svg role="img" aria-label="/);
  assert.ok(!funnelHtml.includes('Persona Con Nombre Real'));
});
