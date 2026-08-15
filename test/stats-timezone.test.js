// Bug real detectado en producción mirando /admin/stats (11/12-ago-2026):
// matchLogDaily/contactLogDaily agrupaban los días en UTC mientras el resto
// de la superficie (el pie del correo, el cron, el panel) habla en hora de
// Bogotá. Entre las 19:00 y la medianoche Bogotá, UTC ya está en el día
// SIGUIENTE — cinco horas de cada día quedaban contadas en la fila
// equivocada. Cuatro coincidencias de las 23:04 del 12-ago Bogotá aparecían
// en la fila "2026-08-13".
//
// Lo que estos tests fijan: el corte de "día" es el de Bogotá en los DOS
// adapters (mismo timestamp, misma fila, en SQLite y en Postgres), y
// gatherDailySeries (el consumidor en report.js/adminStats.js) deriva sus
// claves de día y su "disponible desde" con el mismo corte — nunca mezclando
// un bucket de Bogotá con una comparación en UTC.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { gatherDailySeries, bogotaDayKey } = require('../src/report');

// 23:04 del 12-ago-2026 hora de Bogotá (UTC-5) = 04:04 del 13-ago-2026 UTC —
// exactamente la franja de las 19:00-24:00 Bogotá que el bug corría al día
// siguiente. `created_at` en SQLite es TEXT ISO en UTC (ver schema).
const LATE_BOGOTA_UTC = '2026-08-13T04:04:00Z';
const EXPECTED_BOGOTA_DAY = '2026-08-12';
const WRONG_UTC_DAY = '2026-08-13';

async function sqliteAdapterWithTempFile() {
  const dbPath = path.join(os.tmpdir(), `encontrados-tz-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const adapter = await createSqliteAdapter(dbPath);
  return {
    adapter,
    dbPath,
    async cleanup() {
      await adapter.close();
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  };
}

// Inserta una fila cruda con un created_at explícito — los escritores de
// alto nivel (insertMatchLog/insertContactLog) siempre usan el default de la
// columna (now()/strftime), así que fijar el instante exacto de la
// regresión exige SQL directo, igual que test/schema-log-tables.test.js.
function insertLogRow(dbPath, table, { personId, createdAt, extra }) {
  const raw = new Database(dbPath);
  try {
    if (table === 'match_log') {
      raw
        .prepare(
          "INSERT INTO match_log (person_id, update_id, face_id, similarity, surface, created_at) VALUES (?, NULL, 'cara-tz', 91, 'rescate', ?)"
        )
        .run(personId, createdAt);
    } else {
      raw
        .prepare(
          `INSERT INTO contact_log (person_id, update_id, channel, result, created_at) VALUES (?, NULL, ?, ?, ?)`
        )
        .run(personId, extra.channel, extra.result, createdAt);
    }
  } finally {
    raw.close();
  }
}

test('bogotaDayKey: un instante de las 19:00-24:00 Bogotá cae en el día de BOGOTÁ, no en el de UTC', () => {
  assert.equal(bogotaDayKey(new Date(LATE_BOGOTA_UTC)), EXPECTED_BOGOTA_DAY);
});

test('SQLite matchLogDaily: una coincidencia de las 23:04 Bogotá se cuenta en el día de Bogotá', async () => {
  const { adapter, dbPath, cleanup } = await sqliteAdapterWithTempFile();
  try {
    const person = await adapter.insertPerson('Persona TZ', 'persona tz', '');
    insertLogRow(dbPath, 'match_log', { personId: person.id, createdAt: LATE_BOGOTA_UTC });

    const daily = await adapter.matchLogDaily();
    const bogotaRow = daily.find((r) => r.day === EXPECTED_BOGOTA_DAY);
    const utcRow = daily.find((r) => r.day === WRONG_UTC_DAY);

    assert.ok(bogotaRow, 'debía quedar una fila en el día de Bogotá (12-ago)');
    assert.equal(bogotaRow.count, 1);
    assert.equal(utcRow, undefined, 'no debe quedar ninguna fila en el día de UTC (13-ago) — esa era la regresión');
  } finally {
    await cleanup();
  }
});

test('SQLite contactLogDaily: un envío de las 23:04 Bogotá se cuenta en el día de Bogotá', async () => {
  const { adapter, dbPath, cleanup } = await sqliteAdapterWithTempFile();
  try {
    const person = await adapter.insertPerson('Persona TZ', 'persona tz', '');
    insertLogRow(dbPath, 'contact_log', {
      personId: person.id,
      createdAt: LATE_BOGOTA_UTC,
      extra: { channel: 'email', result: 'enviado' }
    });

    const daily = await adapter.contactLogDaily();
    const bogotaRow = daily.find((r) => r.day === EXPECTED_BOGOTA_DAY);
    const utcRow = daily.find((r) => r.day === WRONG_UTC_DAY);

    assert.ok(bogotaRow, 'debía quedar una fila en el día de Bogotá (12-ago)');
    assert.equal(bogotaRow.count, 1);
    assert.equal(utcRow, undefined, 'no debe quedar ninguna fila en el día de UTC (13-ago) — esa era la regresión');
  } finally {
    await cleanup();
  }
});

test('SQLite matchLogEarliest + gatherDailySeries: "disponible desde" usa el mismo corte de Bogotá que los buckets', async () => {
  const { adapter, dbPath, cleanup } = await sqliteAdapterWithTempFile();
  try {
    const person = await adapter.insertPerson('Persona TZ', 'persona tz', '');
    insertLogRow(dbPath, 'match_log', { personId: person.id, createdAt: LATE_BOGOTA_UTC });

    const daily = await gatherDailySeries(adapter, { days: 7 });
    const bogotaRow = daily.find((d) => d.day === EXPECTED_BOGOTA_DAY);

    // Si "disponible desde" comparara contra el día de UTC (el bug viejo),
    // el día de Bogotá que SÍ tiene el registro quedaría marcado como no
    // disponible — el mismo tipo de mentira por omisión que ya corrigió
    // test/instrumentation-window.test.js, pero por el lado de la zona horaria.
    assert.ok(bogotaRow, 'el día de Bogotá con el registro debe estar en la ventana de 7 días');
    assert.ok(bogotaRow.matchesAvailable, 'el día de Bogotá con el registro real debe quedar "disponible"');
    assert.equal(bogotaRow.matches, 1);
  } finally {
    await cleanup();
  }
});

// El adapter de Postgres no corre contra una base real en esta suite (ver
// test/schema-bootstrap.test.js) — se verifica la FORMA del SQL con un `pg`
// de mentiras, igual que ahí: que matchLogDaily/contactLogDaily corten por
// 'America/Bogota' y no por 'UTC', para que los dos motores compartan
// exactamente el mismo corte de día.
async function withFakePostgresAdapter(run) {
  const pgPath = require.resolve('pg');
  const storePath = require.resolve('../src/store/postgres');
  const savedPg = require.cache[pgPath];
  const savedStore = require.cache[storePath];
  const statements = [];

  class FakePool {
    constructor() {}
    // Una fila vacía, no ninguna: `one()` en el adapter lee `.rows[0]` y
    // hace `r.min || null` — con `rows: []` eso revienta leyendo `.min` de
    // `undefined` antes de llegar siquiera al `|| null`.
    async query(sql) {
      statements.push(String(sql));
      return { rows: [{}] };
    }
  }
  require.cache[pgPath] = {
    id: pgPath,
    filename: pgPath,
    loaded: true,
    exports: { Pool: FakePool }
  };
  delete require.cache[storePath];
  try {
    const { createPostgresAdapter } = require('../src/store/postgres');
    const adapter = await createPostgresAdapter('postgres://fake/db');
    await run(adapter, statements);
  } finally {
    delete require.cache[storePath];
    if (savedPg) require.cache[pgPath] = savedPg;
    else delete require.cache[pgPath];
    if (savedStore) require.cache[storePath] = savedStore;
  }
}

test('Postgres: matchLogDaily/contactLogDaily cortan por America/Bogota, no por UTC', async () => {
  await withFakePostgresAdapter(async (adapter, statements) => {
    await adapter.matchLogDaily();
    await adapter.contactLogDaily();

    const matchSql = statements.find((s) => /FROM match_log/.test(s) && /GROUP BY day\b/.test(s) && !/GROUP BY day, result/.test(s));
    const contactSql = statements.find((s) => /FROM contact_log/.test(s) && /GROUP BY day, result/.test(s));

    assert.ok(matchSql, 'debía emitirse la consulta de matchLogDaily');
    assert.ok(contactSql, 'debía emitirse la consulta de contactLogDaily');
    assert.match(matchSql, /AT TIME ZONE 'America\/Bogota'/);
    assert.match(contactSql, /AT TIME ZONE 'America\/Bogota'/);
    assert.doesNotMatch(matchSql, /AT TIME ZONE 'UTC'/, 'el bucket de día no debe volver a cortar en UTC');
    assert.doesNotMatch(contactSql, /AT TIME ZONE 'UTC'/, 'el bucket de día no debe volver a cortar en UTC');
  });
});

test('Postgres: matchLogEarliest/contactLogEarliest siguen devolviendo el INSTANTE real en UTC (no un bucket de día)', async () => {
  // A propósito NO se mueven a America/Bogota: son un instante que new
  // Date()/bogotaClock() localizan después para mostrarlo, y devolver un
  // wall-clock de Bogotá con una 'Z' literal correría el instante 5 horas.
  // El corte de día que sí necesitaba Bogotá vive en gatherDailySeries
  // (report.js, bogotaDayKey), no acá.
  await withFakePostgresAdapter(async (adapter, statements) => {
    await adapter.matchLogEarliest();
    await adapter.contactLogEarliest();

    const matchSql = statements.find((s) => /FROM match_log/.test(s) && /MIN\(created_at\)/.test(s));
    const contactSql = statements.find((s) => /FROM contact_log/.test(s) && /MIN\(created_at\)/.test(s));

    assert.match(matchSql, /AT TIME ZONE 'UTC'/);
    assert.match(contactSql, /AT TIME ZONE 'UTC'/);
  });
});
