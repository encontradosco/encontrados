// El seed de datos sintéticos (`npm run seed`).
//
// Lo que protegen estas pruebas es lo que hace que el seed sea seguro y útil,
// en ese orden:
//   1. Que se NIEGUE a correr contra cualquier cosa que no sea la base local.
//      Es la única línea entre "llenar mi SQLite de datos falsos" y "escribir
//      datos falsos en la base de una emergencia real".
//   2. Que cada cifra del panel tenga algo que mostrar — incluidas las que solo
//      existen cuando algo va mal (fallos de envío, fotos sin indexar).
//   3. Que correrlo dos veces no duplique nada.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { sembrar, razonesParaNegarse } = require('../scripts/seed');

// Entorno "limpio": el de la máquina de quien corre las pruebas puede tener un
// DATABASE_URL puesto, y eso haría fallar la siembra por la razón correcta en
// el momento equivocado.
const LOCAL = {};

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'encontrados-seed-'));
  return path.join(dir, 'seed.db');
}

test('se niega a sembrar contra cualquier cosa que no sea la base local', async (t) => {
  await t.test('Postgres por nombre de variable conocido', () => {
    assert.match(
      razonesParaNegarse({ DATABASE_URL: 'postgres://u:p@host/db' }).join(' '),
      /DATABASE_URL/
    );
    assert.ok(razonesParaNegarse({ POSTGRES_URL: 'x' }).length);
    assert.ok(razonesParaNegarse({ NEON_DATABASE_URL: 'x' }).length);
  });

  // La integración de Vercel inyecta la cadena bajo prefijos que nadie
  // predijo, así que el valor tiene que delatarla aunque el nombre no.
  await t.test('Postgres por el valor, bajo un nombre inventado', () => {
    assert.match(
      razonesParaNegarse({ MI_PREFIJO_RARO_URL: 'postgresql://u:p@host/db' }).join(' '),
      /MI_PREFIJO_RARO_URL/
    );
  });

  await t.test('dentro de un deployment o con NODE_ENV=production', () => {
    assert.ok(razonesParaNegarse({ VERCEL: '1' }).length);
    assert.ok(razonesParaNegarse({ NODE_ENV: 'production' }).length);
  });

  await t.test('una base local no da ninguna razón', () => {
    assert.deepEqual(razonesParaNegarse(LOCAL), []);
  });

  // Y que la negativa sea de verdad: no basta con que la función liste
  // razones, sembrar() tiene que reventar antes de abrir nada.
  await t.test('sembrar() revienta, no avisa y sigue', async () => {
    const dbPath = tmpDb();
    await assert.rejects(
      () => sembrar({ dbPath, entorno: { DATABASE_URL: 'postgres://u:p@host/db' }, log: null }),
      /se niega a correr/
    );
    assert.equal(fs.existsSync(dbPath), false, 'no debería haber creado ni el archivo');
  });
});

test('siembra lo que el panel necesita para no mostrar ceros', async (t) => {
  const dbPath = tmpDb();
  const resumen = await sembrar({ dbPath, entorno: LOCAL, log: null });
  const db = new Database(dbPath, { readonly: true });
  t.after(() => db.close());

  const uno = (sql, ...p) => db.prepare(sql).get(...p);
  const todos = (sql, ...p) => db.prepare(sql).all(...p);

  await t.test('personas y fichas: la deduplicación se puede ver funcionar', () => {
    // La cifra que el panel explica ("es menor que las fichas porque una misma
    // persona aparece varias veces") no se puede ver si nada se fusionó.
    assert.ok(resumen.fichasFusionadas >= 5, 'sin fichas fusionadas la dedupe es invisible');
    assert.equal(resumen.personasReportadas + resumen.anclas, resumen.personas);
    // Y que la fusión sea real en la base, no solo en el resumen: hay personas
    // con más de una ficha.
    const conVarias = uno(
      `SELECT COUNT(*) AS n FROM (
         SELECT person_id FROM updates WHERE external_id LIKE 'seed:%' GROUP BY person_id HAVING COUNT(*) > 1
       )`
    ).n;
    assert.ok(conVarias >= 5, `solo ${conVarias} personas con más de una ficha`);
  });

  await t.test('los dos lados del cruce tienen fotos', () => {
    assert.ok(uno("SELECT COUNT(*) AS n FROM photos WHERE kind = 'report'").n >= 5);
    assert.ok(uno("SELECT COUNT(*) AS n FROM photos WHERE kind = 'query'").n >= 5);
    // Fotos sin firma facial: el panel muestra "fotos (en el índice)" como dos
    // números, y con todas indexadas ese contraste no existe.
    assert.ok(uno('SELECT COUNT(*) AS n FROM photos WHERE face_id IS NULL').n >= 1);
  });

  // La regla de las dos fotos, opuesta a propósito (CLAUDE.md §4): la del
  // rescatista se compara y sus bytes se borran. Un seed que la guardara
  // enseñaría lo contrario de lo que el repo hace.
  await t.test('la foto de quien consulta queda sin bytes', () => {
    const conBytes = uno("SELECT COUNT(*) AS n FROM photos WHERE kind = 'query' AND length(content) > 0").n;
    assert.equal(conBytes, 0);
  });

  await t.test('coincidencias en los cuatro tramos y en las tres superficies', () => {
    const tramo = (min, max) =>
      uno('SELECT COUNT(*) AS n FROM match_log WHERE similarity >= ? AND similarity <= ?', min, max).n;
    assert.ok(tramo(100, 100) > 0, 'sin el tramo de 100% no se ve la alarma de calidad');
    assert.ok(tramo(99, 99.9999) > 0);
    assert.ok(tramo(95, 98.9999) > 0);
    assert.ok(tramo(90, 94.9999) > 0);
    // El umbral del matcher es 90: por debajo el reconocimiento facial no
    // devuelve nada, así que sembrarlo sería sembrar algo imposible.
    assert.equal(uno('SELECT COUNT(*) AS n FROM match_log WHERE similarity < 90').n, 0);

    const superficies = todos('SELECT DISTINCT surface FROM match_log ORDER BY surface').map((r) => r.surface);
    assert.deepEqual(superficies, ['api', 'report', 'rescate']);
  });

  await t.test('envíos: los tres resultados en los tres canales, con fallos', () => {
    for (const channel of ['email', 'whatsapp', 'relevo']) {
      for (const result of ['enviado', 'fallido', 'rechazado']) {
        const n = uno('SELECT COUNT(*) AS n FROM contact_log WHERE channel = ? AND result = ?', channel, result).n;
        assert.ok(n > 0, `no hay ningún ${result} por ${channel} — el panel pone los fallos primero`);
      }
    }
  });

  await t.test('el último escalón del embudo: personas a salvo', () => {
    assert.ok(resumen.aSalvo >= 5, `solo ${resumen.aSalvo} personas a salvo`);
  });

  await t.test('conteos por encima y por debajo de la supresión de celdas pequeñas', () => {
    // El panel muestra `<5` cuando un conteo está entre 1 y 4. Hacen falta las
    // dos cosas: celdas grandes para leer números reales, y alguna pequeña
    // para ver la supresión funcionando.
    const celdas = todos('SELECT COUNT(*) AS n FROM match_log GROUP BY surface').map((r) => r.n);
    assert.ok(celdas.some((n) => n >= 5), 'ninguna celda supera la supresión');
    const finas = todos(
      `SELECT COUNT(*) AS n FROM match_log
       GROUP BY surface, CASE WHEN similarity >= 100 THEN 4 WHEN similarity >= 99 THEN 3 WHEN similarity >= 95 THEN 2 ELSE 1 END`
    ).map((r) => r.n);
    assert.ok(finas.some((n) => n >= 1 && n <= 4), 'ninguna celda cae en el rango suprimido');
  });

  await t.test('la serie diaria tiene forma en los últimos 7 días', () => {
    // El corte de día es el de Bogotá (-5h), el mismo que usan los adapters.
    const dias = todos(
      "SELECT date(created_at, '-5 hours') AS dia, COUNT(*) AS n FROM match_log GROUP BY dia ORDER BY dia"
    );
    assert.ok(dias.length >= 7, `solo ${dias.length} días con coincidencias`);
    assert.ok(dias.every((d) => d.n > 0));
  });

  // Sin filas cerca de la medianoche de Bogotá, un futuro desfase a UTC
  // agruparía mal cinco horas de cada día y nadie lo notaría hasta que lo
  // viera un usuario. Las 23:00 de Bogotá son las 04:00 UTC del día siguiente.
  await t.test('hay filas en la frontera de día de Bogotá', () => {
    const frontera = uno(
      "SELECT COUNT(*) AS n FROM match_log WHERE substr(created_at, 12, 2) IN ('03', '04', '05')"
    ).n;
    assert.ok(frontera > 0, 'nada cerca de la medianoche de Bogotá — el desfase a UTC sería invisible');
  });

  await t.test('nada de lo sembrado tiene forma de dato real', () => {
    for (const p of todos('SELECT full_name FROM people')) {
      assert.match(p.full_name, /^(Persona prueba|Persona rescatada|Búsqueda por foto)/i, p.full_name);
    }
    for (const s of todos("SELECT address FROM subscriptions WHERE channel = 'email'")) {
      assert.match(s.address, /@ejemplo\.com$/, s.address);
    }
  });
});

test('correrlo dos veces no duplica nada', async () => {
  const dbPath = tmpDb();
  const primera = await sembrar({ dbPath, entorno: LOCAL, log: null });
  const segunda = await sembrar({ dbPath, entorno: LOCAL, log: null });

  assert.equal(segunda.borradas, primera.personas, 'la segunda corrida debe borrar lo de la primera');
  for (const clave of ['personas', 'fichas', 'fotos', 'coincidencias', 'envios', 'suscripciones']) {
    assert.equal(segunda[clave], primera[clave], `cambió ${clave} entre corridas`);
  }
});

test('respeta lo que no sembró él', async () => {
  const dbPath = tmpDb();
  await sembrar({ dbPath, entorno: LOCAL, log: null });

  // Una persona creada a mano, probando: no lleva ninguna marca del seed.
  const db = new Database(dbPath);
  db.prepare("INSERT INTO people (full_name, normalized_name, phonetic_name) VALUES (?, ?, ?)").run(
    'Persona Prueba Mia',
    'persona prueba mia',
    ''
  );
  db.close();

  await sembrar({ dbPath, entorno: LOCAL, log: null });

  const revisar = new Database(dbPath, { readonly: true });
  const sobrevivio = revisar
    .prepare("SELECT COUNT(*) AS n FROM people WHERE full_name = 'Persona Prueba Mia'")
    .get().n;
  revisar.close();
  assert.equal(sobrevivio, 1, 'el seed borró datos que no eran suyos');
});
