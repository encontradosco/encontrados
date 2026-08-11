// El arranque del esquema de Postgres corre en CADA cold start, y en Vercel
// varias instancias arrancan a la vez contra la MISMA base. Todo lo que el
// bootstrap emite tiene que ser seguro ejecutado en paralelo consigo mismo.
//
// Estas pruebas no levantan Postgres (la suite corre sobre SQLite): capturan
// los statements que `createPostgresAdapter` emite, con un `pg` de mentiras, y
// verifican la forma del SQL. No prueban concurrencia real — prueban la
// invariante que la hace imposible de romper por descuido.
const test = require('node:test');
const assert = require('node:assert');

// Captura el SQL del bootstrap sustituyendo `pg` en el cache de módulos.
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

test('esquema: ningún statement suelta un constraint sin reponerlo en el mismo statement', async () => {
  const statements = await bootstrapStatements();

  const drops = statements.filter((s) => /DROP\s+CONSTRAINT/i.test(s));
  assert.ok(drops.length > 0, 'se esperaba al menos un DROP CONSTRAINT en el bootstrap');

  for (const sql of drops) {
    const dropped = sql.match(/DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?(\w+)/i)[1];
    assert.match(
      sql,
      new RegExp(`ADD\\s+CONSTRAINT\\s+${dropped}\\b`, 'i'),
      // Separados en dos statements, dos instancias arrancando a la vez se
      // intercalan (A dropea, B dropea, A agrega, B agrega) y la segunda muere
      // con 42710 "already exists", que se lleva por delante el arranque entero.
      `"${dropped}" se dropea y se repone en statements distintos: eso es una carrera entre instancias. ` +
        'Van juntos en un solo ALTER TABLE, que Postgres serializa con el lock de la tabla.'
    );
  }
});

test('esquema: el CHECK de source acepta las cinco fuentes vivas', async () => {
  const statements = await bootstrapStatements();

  const check = statements.find((s) => /ADD\s+CONSTRAINT\s+updates_source_check/i.test(s));
  assert.ok(check, 'el bootstrap debe reponer updates_source_check');
  for (const source of ['web', 'whatsapp', 'api', 'aggregator', 'rescate']) {
    assert.match(check, new RegExp(`'${source}'`), `updates_source_check dejó de aceptar '${source}'`);
  }
});
