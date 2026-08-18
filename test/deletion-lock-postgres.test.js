// El lado Postgres del arreglo a la condición de carrera de #192
// (coderabbitai): la admisión y el borrado a solicitud comparten un advisory
// lock de sesión por external_id (withExternalIdLock en src/store/postgres.js).
// No hay Postgres real en este entorno — mismo límite que test/schema-*.test.js
// — así que esto no puede probar contención de un advisory lock de verdad
// entre dos conexiones; lo que SÍ puede probar, con un `pg` de mentira que
// además de `query`/`connect` HACE CUMPLIR `max` (con una cola FIFO, como el
// `pg.Pool` real), es la forma del SQL y —lo que QA encontró en la primera
// versión de este arreglo— que sostener el lock nunca agota el pool del que
// `fn` necesita sacar sus propias conexiones.
//
// QA: `withExternalIdLock` pedía su conexión dedicada al MISMO `pool` que usa
// `fn` para sus queries normales (isExternalIdSuppressed / findOrCreatePerson
// / insertUpdate). Con `Pool({ max: 3 })`, tres admisiones concurrentes de
// llaves DISTINTAS (que no compiten por el mismo advisory lock, así que no
// hay razón de negocio para que se esperen) bastaban para que las tres
// sostuvieran una conexión del lock y ninguna tuviera una libre para su propio
// `fn` — un deadlock del pool entero. El arreglo: una conexión dedicada, en un
// pool APARTE y chico (`lockPool`), que nunca compite con el pool principal.
const test = require('node:test');
const assert = require('node:assert');

// Como test/schema-suppression-table.test.js, pero este `pg` de mentira además
// de `connect()` hace cumplir `max` con una cola FIFO — sin eso no hay forma
// de que una prueba reproduzca "el pool se quedó sin conexiones libres".
// `pools` guarda cada `new Pool(...)` que el adaptador construya, en el orden
// en que las construye: la primera es siempre `pool` (el principal, las
// queries normales), la segunda es `lockPool` (la del advisory lock).
async function withFakePostgresAdapter(rowsFor, run) {
  const pgPath = require.resolve('pg');
  const storePath = require.resolve('../src/store/postgres');
  const savedPg = require.cache[pgPath];
  const savedStore = require.cache[storePath];

  const pools = [];

  class FakeClient {
    constructor(onRelease) {
      this.calls = [];
      this.released = false;
      this._onRelease = onRelease;
    }
    async query(text, params) {
      this.calls.push({ text: String(text).trim(), params });
      return rowsFor(String(text), params) || { rows: [], rowCount: 0 };
    }
    release() {
      if (this.released) return;
      this.released = true;
      this._onRelease();
    }
  }

  class FakePool {
    constructor(opts) {
      this.max = (opts && opts.max) || Infinity;
      this.active = 0;
      this.waiters = [];
      this.calls = [];
      this.clients = [];
      pools.push(this);
    }
    async _acquire() {
      if (this.active < this.max) {
        this.active += 1;
        return;
      }
      // Cola FIFO: nadie pasa hasta que alguien suelte una conexión — igual
      // que el `pg.Pool` real cuando ya está en `max`.
      await new Promise((resolve) => this.waiters.push(resolve));
      this.active += 1;
    }
    _release() {
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) next();
    }
    async query(text, params) {
      await this._acquire();
      try {
        this.calls.push({ text: String(text).trim(), params });
        return rowsFor(String(text), params) || { rows: [], rowCount: 0 };
      } finally {
        this._release();
      }
    }
    async connect() {
      await this._acquire();
      const client = new FakeClient(() => this._release());
      this.clients.push(client);
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
    return await run({ adapter, pools });
  } finally {
    delete require.cache[storePath];
    if (savedPg) require.cache[pgPath] = savedPg;
    else delete require.cache[pgPath];
    if (savedStore) require.cache[storePath] = savedStore;
  }
}

test('Postgres: withExternalIdLock toma el advisory lock antes de correr fn y lo suelta siempre, en una conexión dedicada del lockPool (no del pool principal)', async () => {
  await withFakePostgresAdapter(
    () => null,
    async ({ adapter, pools }) => {
      let corrioFn = false;
      const resultado = await adapter.withExternalIdLock('clave-x', async () => {
        corrioFn = true;
        return 'listo';
      });

      assert.equal(corrioFn, true);
      assert.equal(resultado, 'listo');
      assert.equal(pools.length, 2, 'un pool principal y uno aparte para el lock');
      const [mainPool, lockPool] = pools;
      assert.equal(mainPool.clients.length, 0, 'el lock no debe tocar el pool principal para nada');
      assert.equal(lockPool.clients.length, 1, 'una sola conexión dedicada, no una por query');

      const [client] = lockPool.clients;
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
    async ({ adapter, pools }) => {
      await assert.rejects(
        adapter.withExternalIdLock('clave-x', async () => {
          throw new Error('boom');
        }),
        /boom/
      );
      const [, lockPool] = pools;
      const [client] = lockPool.clients;
      assert.equal(client.calls.at(-1).text, 'SELECT pg_advisory_unlock(hashtext($1))');
      assert.equal(client.released, true, 'la conexión se libera aunque fn haya lanzado');
    }
  );
});

test('Postgres: tres admisiones concurrentes de llaves DISTINTAS no agotan el pool ni se traban entre sí', async () => {
  // Antes del arreglo, esto se quedaba esperando para siempre: las tres
  // sostenían la única conexión dedicada al lock que su `withExternalIdLock`
  // pedía al MISMO pool que su propio `isExternalIdSuppressed` necesitaba —
  // con `max: 3` (la configuración real de `pool`), las tres agotaban el pool
  // sosteniendo el lock y ninguna tenía una conexión libre para su propia
  // query. Nada en este escenario compite por el mismo advisory lock (son
  // tres llaves distintas), así que no había ninguna razón de negocio para
  // que se esperaran entre sí — era puro agotamiento del pool.
  function rowsFor(text) {
    if (text.trim().startsWith('SELECT 1 FROM suppressed_external_ids')) return { rows: [] };
    return null;
  }

  await withFakePostgresAdapter(rowsFor, async ({ adapter }) => {
    const admisiones = ['clave-a', 'clave-b', 'clave-c'].map((clave) =>
      adapter.withExternalIdLock(clave, () => adapter.isExternalIdSuppressed(clave))
    );

    const resultado = await Promise.race([
      Promise.all(admisiones),
      new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 500))
    ]);

    assert.notEqual(
      resultado,
      'TIMEOUT',
      'tres admisiones concurrentes de llaves distintas no deberían trabar el pool entre sí'
    );
    assert.deepEqual(resultado, [false, false, false]);
  });
});

test('Postgres: deletePerson a solicitud pide el advisory lock de cada llave — ordenadas, antes del BEGIN, en la MISMA conexión que la transacción (todo en el pool principal)', async () => {
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

  await withFakePostgresAdapter(rowsFor, async ({ adapter, pools }) => {
    const resultado = await adapter.deletePerson(42, { atSubjectRequest: true });

    assert.equal(resultado.id, 42);
    assert.equal(resultado.suppressed_external_ids, 2);

    const [mainPool, lockPool] = pools;
    assert.equal(lockPool.clients.length, 0, 'deletePerson no toca el lockPool — no lo necesita');

    // La foto de qué llaves existen se lee ANTES de pedir ninguna conexión
    // dedicada — por el pool directamente, no por un client propio.
    assert.ok(
      mainPool.calls.some((c) => c.text.startsWith('SELECT DISTINCT external_id FROM updates')),
      'la instantánea se lee por el pool, no por el client del lock'
    );

    assert.equal(mainPool.clients.length, 1, 'los locks y la transacción van en la MISMA conexión');
    const [client] = mainPool.clients;

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

  await withFakePostgresAdapter(rowsFor, async ({ adapter, pools }) => {
    const resultado = await adapter.deletePerson(7);

    assert.equal(resultado.suppressed_external_ids, 0);
    const [mainPool, lockPool] = pools;
    assert.ok(
      !mainPool.calls.some((c) => c.text.startsWith('SELECT DISTINCT external_id FROM updates')),
      'sin atSubjectRequest no hay ninguna llave que proteger, así que no se lee ninguna instantánea'
    );
    const [client] = mainPool.clients;
    assert.ok(
      !client.calls.some((c) => /pg_advisory_lock|pg_advisory_unlock/.test(c.text)),
      'un borrado que no suprime nada no tiene por qué pedir ningún lock'
    );
    assert.equal(lockPool.clients.length, 0);
  });
});
