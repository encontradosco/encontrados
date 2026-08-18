// El lado Postgres del arreglo a la condición de carrera de #192
// (coderabbitai): la admisión y el borrado a solicitud ahora comparten un
// advisory lock de sesión por external_id (withExternalIdLock en
// src/store/postgres.js). No hay Postgres real en este entorno — mismo límite
// que test/schema-*.test.js — así que esto no puede probar exclusión mutua de
// verdad contra dos conexiones concurrentes; lo que SÍ puede probar, con un
// `pg` de mentira que además de `query` implementa `connect()`, es la FORMA:
// que el lock se pide antes de escribir y se suelta siempre, en la MISMA
// conexión que la transacción — que es exactamente lo que test/deletion-
// suppression.test.js prueba de verdad contra el mutex en memoria de SQLite.
const test = require('node:test');
const assert = require('node:assert');

// Como test/schema-suppression-table.test.js, pero el FakePool de acá también
// implementa `connect()` — lo que deletePerson y withExternalIdLock necesitan
// y el fake mínimo de los tests de esquema no tiene.
async function withFakePostgresAdapter(rowsFor, run) {
  const pgPath = require.resolve('pg');
  const storePath = require.resolve('../src/store/postgres');
  const savedPg = require.cache[pgPath];
  const savedStore = require.cache[storePath];

  const poolCalls = [];
  const clients = [];

  class FakeClient {
    constructor() {
      this.calls = [];
      this.released = false;
    }
    async query(text, params) {
      this.calls.push({ text: String(text).trim(), params });
      return rowsFor(String(text), params) || { rows: [], rowCount: 0 };
    }
    release() {
      this.released = true;
    }
  }

  class FakePool {
    constructor() {}
    async query(text, params) {
      poolCalls.push({ text: String(text).trim(), params });
      return rowsFor(String(text), params) || { rows: [], rowCount: 0 };
    }
    async connect() {
      const client = new FakeClient();
      clients.push(client);
      return client;
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
    return await run({ adapter, poolCalls, clients });
  } finally {
    delete require.cache[storePath];
    if (savedPg) require.cache[pgPath] = savedPg;
    else delete require.cache[pgPath];
    if (savedStore) require.cache[storePath] = savedStore;
  }
}

test('Postgres: withExternalIdLock toma el advisory lock antes de correr fn y lo suelta siempre, en una sola conexión dedicada', async () => {
  await withFakePostgresAdapter(
    () => null,
    async ({ adapter, clients }) => {
      let corrioFn = false;
      const resultado = await adapter.withExternalIdLock('clave-x', async () => {
        corrioFn = true;
        return 'listo';
      });

      assert.equal(corrioFn, true);
      assert.equal(resultado, 'listo');
      assert.equal(clients.length, 1, 'una sola conexión dedicada, no una por query');
      const [client] = clients;
      assert.equal(client.calls[0].text, 'SELECT pg_advisory_lock(hashtext($1))');
      assert.deepEqual(client.calls[0].params, ['clave-x']);
      assert.equal(client.calls.at(-1).text, 'SELECT pg_advisory_unlock(hashtext($1))');
      assert.deepEqual(client.calls.at(-1).params, ['clave-x']);
      assert.equal(client.released, true);
    }
  );
});

test('Postgres: withExternalIdLock suelta el advisory lock aunque fn lance', async () => {
  await withFakePostgresAdapter(
    () => null,
    async ({ adapter, clients }) => {
      await assert.rejects(
        adapter.withExternalIdLock('clave-x', async () => {
          throw new Error('boom');
        }),
        /boom/
      );
      const [client] = clients;
      assert.equal(client.calls.at(-1).text, 'SELECT pg_advisory_unlock(hashtext($1))');
      assert.equal(client.released, true, 'la conexión se libera aunque fn haya lanzado');
    }
  );
});

test('Postgres: deletePerson a solicitud pide el advisory lock de cada llave — ordenadas, antes del BEGIN, en la MISMA conexión que la transacción', async () => {
  function rowsFor(text) {
    const sql = text.trim();
    if (sql.startsWith('SELECT DISTINCT external_id FROM updates')) {
      // A propósito al revés del orden esperado: el código tiene que ordenar
      // él mismo, no confiar en el orden del SELECT.
      return { rows: [{ external_id: 'ext-b' }, { external_id: 'ext-a' }] };
    }
    if (sql.startsWith('INSERT INTO suppressed_external_ids')) {
      return { rows: [], rowCount: 2 };
    }
    if (sql.startsWith('DELETE FROM people')) {
      return { rows: [{ id: 42, full_name: 'Persona Prueba Postgres' }] };
    }
    return null;
  }

  await withFakePostgresAdapter(rowsFor, async ({ adapter, poolCalls, clients }) => {
    const resultado = await adapter.deletePerson(42, { atSubjectRequest: true });

    assert.equal(resultado.id, 42);
    assert.equal(resultado.suppressed_external_ids, 2);

    // La foto de qué llaves existen se lee ANTES de pedir ninguna conexión
    // dedicada — por el pool directamente, no por un client propio.
    assert.ok(
      poolCalls.some((c) => c.text.startsWith('SELECT DISTINCT external_id FROM updates')),
      'la instantánea se lee por el pool, no por el client del lock'
    );

    assert.equal(clients.length, 1, 'los locks y la transacción van en la MISMA conexión');
    const [client] = clients;

    const beginPos = client.calls.findIndex((c) => c.text === 'BEGIN');
    const commitPos = client.calls.findIndex((c) => c.text === 'COMMIT');
    const unlockAllPos = client.calls.findIndex((c) => c.text === 'SELECT pg_advisory_unlock_all()');
    const lockCalls = client.calls
      .map((c, i) => ({ i, c }))
      .filter(({ c }) => c.text === 'SELECT pg_advisory_lock(hashtext($1))');

    assert.equal(lockCalls.length, 2, 'una llamada de lock por llave');
    assert.deepEqual(
      lockCalls.map(({ c }) => c.params[0]),
      ['ext-a', 'ext-b'],
      'se piden en orden alfabético, sin importar el orden del SELECT — así dos borrados con llaves ' +
        'en común nunca se traban entre sí por pedirlas al revés'
    );
    assert.ok(
      lockCalls.every(({ i }) => i < beginPos),
      'los dos locks se piden ANTES del BEGIN'
    );
    assert.ok(commitPos !== -1 && unlockAllPos > commitPos, 'el unlock va DESPUÉS del COMMIT, nunca antes');
    assert.equal(client.released, true);
  });
});

test('Postgres: deletePerson SIN atSubjectRequest no toca ningún advisory lock (la purga de datos de prueba sigue igual)', async () => {
  function rowsFor(text) {
    const sql = text.trim();
    if (sql.startsWith('DELETE FROM people')) {
      return { rows: [{ id: 7, full_name: 'Prueba Entrega Correo' }] };
    }
    return null;
  }

  await withFakePostgresAdapter(rowsFor, async ({ adapter, poolCalls, clients }) => {
    const resultado = await adapter.deletePerson(7);

    assert.equal(resultado.suppressed_external_ids, 0);
    assert.ok(
      !poolCalls.some((c) => c.text.startsWith('SELECT DISTINCT external_id FROM updates')),
      'sin atSubjectRequest no hay ninguna llave que proteger, así que no se lee ninguna instantánea'
    );
    const [client] = clients;
    assert.ok(
      !client.calls.some((c) => /pg_advisory_lock|pg_advisory_unlock/.test(c.text)),
      'un borrado que no suprime nada no tiene por qué pedir ningún lock'
    );
  });
});
