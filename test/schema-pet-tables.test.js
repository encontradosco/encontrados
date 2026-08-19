// Esquema de pets / pet_photos / pet_subscriptions — hasta esta revisión
// solo estaba probado contra SQLite (test/pets-schema.test.js); el lado de
// Postgres (el que corre en producción) no tenía ninguna cobertura. Mismo
// patrón que test/schema-log-tables.test.js: un `pg` de mentira captura el
// SQL del bootstrap sin necesitar Postgres real.
const test = require('node:test');
const assert = require('node:assert');

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

test('Postgres: el bootstrap crea pets, pet_subscriptions y pet_photos', async () => {
  const statements = await bootstrapStatements();
  const schema = statements.find((s) => /CREATE TABLE IF NOT EXISTS pets/i.test(s));
  assert.ok(schema, 'el bootstrap debe crear pets');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS pet_subscriptions/i);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS pet_photos/i);

  // pets: especie acotada a perro/gato, y campo de resolución.
  assert.match(schema, /pets \(([\s\S]*?)species TEXT NOT NULL CHECK \(species IN \('dog','cat'\)\)/);
  assert.match(schema, /pets \(([\s\S]*?)resolved_at TIMESTAMPTZ/);

  // pet_subscriptions: canal acotado y estado de verificación.
  assert.match(schema, /pet_subscriptions \(([\s\S]*?)channel TEXT NOT NULL CHECK \(channel IN \('email','whatsapp'\)\)/);
  assert.match(schema, /pet_subscriptions \(([\s\S]*?)verified BOOLEAN NOT NULL DEFAULT false/);

  // pet_photos: especie acotada (nunca cruza perro con gato al comparar) y
  // tipo acotado a report/query.
  assert.match(schema, /pet_photos \(([\s\S]*?)kind TEXT NOT NULL CHECK \(kind IN \('report','query'\)\)/);
  assert.match(schema, /pet_photos \(([\s\S]*?)species TEXT NOT NULL CHECK \(species IN \('dog','cat'\)\)/);
});

test('Postgres: pet_photos exige pet_id para una fila "report" (nunca para "query")', async () => {
  const statements = await bootstrapStatements();
  const schema = statements.find((s) => /CREATE TABLE IF NOT EXISTS pet_photos/i.test(s));
  assert.match(
    schema,
    /CHECK \(kind <> 'report' OR pet_id IS NOT NULL\)/,
    'una foto "report" sin mascota asociada debe rechazarla la base, no solo la app'
  );
});

test('Postgres: pet_photos referencia pets y pet_subscriptions con ON DELETE CASCADE', async () => {
  const statements = await bootstrapStatements();
  const schema = statements.find((s) => /CREATE TABLE IF NOT EXISTS pet_photos/i.test(s));
  const block = schema.match(/CREATE TABLE IF NOT EXISTS pet_photos \(([\s\S]*?)\);/)[1];
  assert.match(block, /pet_id INTEGER REFERENCES pets\(id\) ON DELETE CASCADE/);
  assert.match(block, /subscription_id INTEGER REFERENCES pet_subscriptions\(id\) ON DELETE CASCADE/);
});
