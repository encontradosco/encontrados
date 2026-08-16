// Esquema de match_log / contact_log (#116, PR 3 — SOLO esquema; PR 4 escribe
// en estas tablas) y merge_log (#150). Lo que estas pruebas protegen: que el
// bootstrap de Postgres las cree con los enums correctos y sin ningún
// statement que se pise en un cold start concurrente (mismo patrón que
// schema-bootstrap.test.js), que ninguna tenga una columna con forma de PII,
// y que en SQLite realmente queden creadas y hereden la MISMA retención que
// ya rige el esquema: se borran solas cuando se borra la persona (ON DELETE
// CASCADE).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createSqliteAdapter } = require('../src/store/sqlite');

// Ningún nombre, teléfono, correo o texto libre puede tener sentido en estas
// dos tablas — el diseño aprobado en el issue es "sin teléfonos, sin correos,
// sin nombres". Lista deliberadamente amplia: cualquier columna que ase a
// alguno de estos patrones es, por construcción, sospechosa acá.
const PII_SHAPED = /name|full_name|phone|email|address|contact|message|location|reporter/i;

async function bootstrapStatements() {
  const pgPath = require.resolve('pg');
  const storePath = require.resolve('../src/store/postgres');
  const savedPg = require.cache[pgPath];
  const savedStore = require.cache[storePath];
  const statements = [];

  class FakePool {
    constructor() {}
    async query(sql) {
      statements.push(String(sql));
      return { rows: [] };
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
    await createPostgresAdapter('postgres://fake/db');
  } finally {
    delete require.cache[storePath];
    if (savedPg) require.cache[pgPath] = savedPg;
    else delete require.cache[pgPath];
    if (savedStore) require.cache[storePath] = savedStore;
  }
  return statements;
}

test('Postgres: el bootstrap crea match_log, contact_log y merge_log con sus enums', async () => {
  const statements = await bootstrapStatements();
  const schema = statements.find((s) => /CREATE TABLE IF NOT EXISTS match_log/i.test(s));
  assert.ok(schema, 'el bootstrap debe crear match_log');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS contact_log/i);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS merge_log/i);

  // match_log: los tres valores de "superficie" del diseño aprobado.
  for (const surface of ['rescate', 'report', 'api']) {
    assert.match(schema, new RegExp(`'${surface}'`), `match_log.surface debe aceptar '${surface}'`);
  }
  // contact_log: canal y resultado.
  for (const channel of ['email', 'whatsapp', 'relevo']) {
    assert.match(schema, new RegExp(`'${channel}'`), `contact_log.channel debe aceptar '${channel}'`);
  }
  for (const result of ['enviado', 'fallido', 'rechazado']) {
    assert.match(schema, new RegExp(`'${result}'`), `contact_log.result debe aceptar '${result}'`);
  }
  // merge_log (#150): los tres valores de department_match/face_match.
  for (const outcome of ['match', 'mismatch', 'unknown']) {
    assert.match(schema, new RegExp(`'${outcome}'`), `merge_log debe aceptar '${outcome}'`);
  }

  // Las tres heredan la retención existente: se van con la persona.
  assert.match(schema, /match_log[\s\S]*?person_id INTEGER NOT NULL REFERENCES people\(id\) ON DELETE CASCADE/);
  assert.match(schema, /contact_log[\s\S]*?person_id INTEGER NOT NULL REFERENCES people\(id\) ON DELETE CASCADE/);
  assert.match(schema, /merge_log[\s\S]*?person_id INTEGER NOT NULL REFERENCES people\(id\) ON DELETE CASCADE/);
});

test('Postgres: ni match_log, ni contact_log, ni merge_log declaran una columna con forma de PII', async () => {
  const statements = await bootstrapStatements();
  const schema = statements.find((s) => /CREATE TABLE IF NOT EXISTS match_log/i.test(s));
  const matchLogBlock = schema.match(/CREATE TABLE IF NOT EXISTS match_log \(([\s\S]*?)\);/)[1];
  const contactLogBlock = schema.match(/CREATE TABLE IF NOT EXISTS contact_log \(([\s\S]*?)\);/)[1];
  const mergeLogBlock = schema.match(/CREATE TABLE IF NOT EXISTS merge_log \(([\s\S]*?)\);/)[1];

  for (const [name, block] of [
    ['match_log', matchLogBlock],
    ['contact_log', contactLogBlock],
    ['merge_log', mergeLogBlock]
  ]) {
    const columnNames = block
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('CHECK') && !l.startsWith('--'))
      .map((l) => l.split(/\s+/)[0]);
    for (const col of columnNames) {
      assert.ok(!PII_SHAPED.test(col), `${name}.${col} tiene forma de columna con PII — no debería existir`);
    }
  }
});

test('SQLite: las tablas quedan creadas, sin columnas con forma de PII', async () => {
  const dbPath = path.join(os.tmpdir(), `encontrados-schema-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const adapter = await createSqliteAdapter(dbPath);
  try {
    const raw = new Database(dbPath, { readonly: true });
    try {
      for (const table of ['match_log', 'contact_log', 'merge_log']) {
        const cols = raw.prepare(`PRAGMA table_info(${table})`).all();
        assert.ok(cols.length > 0, `${table} no existe`);
        for (const c of cols) {
          assert.ok(!PII_SHAPED.test(c.name), `${table}.${c.name} tiene forma de columna con PII`);
        }
      }
    } finally {
      raw.close();
    }
  } finally {
    await adapter.close();
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }
});

test('SQLite: match_log, contact_log y merge_log se borran solos cuando se borra la persona (misma retención que updates/photos)', async () => {
  const dbPath = path.join(os.tmpdir(), `encontrados-schema-cascade-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const adapter = await createSqliteAdapter(dbPath);
  try {
    const person = await adapter.insertPerson('Persona De Prueba Esquema', 'persona de prueba esquema', '');

    // Fila cruda mínima en `updates` — el adapter de bajo nivel no expone un
    // helper de alto nivel acá (vive en people.js), así que se inserta con SQL
    // directo, igual que match_log/contact_log (que hoy no tienen NINGÚN
    // escritor de bajo nivel acá: PR 3 es solo esquema).
    const raw = new Database(dbPath);
    raw.pragma('foreign_keys = ON');
    try {
      const updateInfo = raw
        .prepare(
          "INSERT INTO updates (person_id, status, source) VALUES (?, 'missing', 'web')"
        )
        .run(person.id);
      raw
        .prepare(
          "INSERT INTO match_log (person_id, update_id, face_id, similarity, surface) VALUES (?, ?, 'cara-de-prueba', 96.5, 'rescate')"
        )
        .run(person.id, updateInfo.lastInsertRowid);
      raw
        .prepare(
          "INSERT INTO contact_log (person_id, update_id, channel, result) VALUES (?, ?, 'email', 'enviado')"
        )
        .run(person.id, updateInfo.lastInsertRowid);
      raw
        .prepare(
          "INSERT INTO merge_log (person_id, update_id, score, department_match, face_match, blocked) VALUES (?, ?, 0.9, 'match', 'unknown', 0)"
        )
        .run(person.id, updateInfo.lastInsertRowid);

      assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM match_log').get().n, 1);
      assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM contact_log').get().n, 1);
      assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM merge_log').get().n, 1);

      await adapter.deletePerson(person.id);

      assert.equal(
        raw.prepare('SELECT COUNT(*) AS n FROM match_log').get().n,
        0,
        'match_log debía vaciarse al borrar la persona'
      );
      assert.equal(
        raw.prepare('SELECT COUNT(*) AS n FROM contact_log').get().n,
        0,
        'contact_log debía vaciarse al borrar la persona'
      );
      assert.equal(
        raw.prepare('SELECT COUNT(*) AS n FROM merge_log').get().n,
        0,
        'merge_log debía vaciarse al borrar la persona'
      );
    } finally {
      raw.close();
    }
  } finally {
    await adapter.close();
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }
});
