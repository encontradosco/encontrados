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
const { createSqliteAdapter } = require('../src/store/sqlite');

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

// privacy_actions (#161): a diferencia de match_log/contact_log, esta tabla SÍ
// guarda un dato con forma de PII a propósito — `actor`, el correo del admin
// autenticado que ejecutó la acción — porque es la prueba de quién autorizó un
// borrado de biometría, no una métrica de producto. Lo que sigue fijando esta
// prueba es la forma del resto: referencia a people(id) con cascada, y el
// enum de acciones abierto solo a lo que hoy existe.
test('esquema: privacy_actions cuelga de people(id) con ON DELETE CASCADE', async () => {
  const statements = await bootstrapStatements();
  const schema = statements.find((s) => /CREATE TABLE IF NOT EXISTS privacy_actions/i.test(s));
  assert.ok(schema, 'el bootstrap debe crear privacy_actions');
  assert.match(schema, /person_id INTEGER NOT NULL REFERENCES people\(id\) ON DELETE CASCADE/);
  assert.match(schema, /action TEXT NOT NULL CHECK \(action IN \('forget_face'\)\)/);
  assert.match(schema, /actor TEXT NOT NULL/);
  // El resultado REAL del retiro, no la intención — ver el comentario en
  // src/store/postgres.js. Sin esto la fila no distingue un retiro completo
  // de uno que dejó firmas indexadas.
  assert.match(schema, /unconfirmed_count INTEGER NOT NULL DEFAULT 0/);
});

test('esquema: privacy_actions hereda la retención de people en SQLite (la base real de la suite)', async () => {
  const store = await createSqliteAdapter(':memory:');
  const person = await store.insertPerson('Persona Prueba Uno', 'persona prueba uno', '');
  await store.recordPrivacyAction({ personId: person.id, action: 'forget_face', actor: 'admin@ejemplo.com' });
  assert.equal((await store.privacyActionsForPerson(person.id)).length, 1);

  await store.deletePerson(person.id);
  assert.deepEqual(
    await store.privacyActionsForPerson(person.id),
    [],
    'borrar la persona debe llevarse también la constancia — misma retención que el resto del esquema'
  );
});
