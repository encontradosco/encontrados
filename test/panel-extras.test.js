// Cifras nuevas del panel de estadísticas (#132) y la supresión de celdas
// pequeñas que las cubre — decisión de privacidad tomada en la misma noche
// (el panel es público mientras el auth real no esté listo, ver
// adminAuth.js). Lo que este archivo protege:
//   - suppressedCell/suppressBreakdown (report.js): las reglas puras de
//     supresión primaria y secundaria, sin nada de HTTP ni de base de datos.
//   - gatherDuplicateBreakdown/gatherRescuedPeopleCount/
//     gatherSimilarityTierBreakdown/gatherRescueContactAvailability
//     (report.js): las cuentas nuevas, contra SQLite real.
//   - Los tres métodos nuevos del adapter de Postgres tienen la FORMA de SQL
//     esperada (mismo patrón que test/stats-timezone.test.js: un `pg` de
//     mentiras que solo captura los statements).
//   - RESCUE_ANCHOR_PREFIX/RESCUE_ANCHOR_NORMALIZED_PREFIX (people.js) no se
//     desincronizan entre sí.
const test = require('node:test');
const assert = require('node:assert');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createStore } = require('../src/people');
const {
  suppressedCell,
  suppressBreakdown,
  gatherDuplicateBreakdown,
  gatherRescuedPeopleCount,
  gatherSimilarityTierBreakdown,
  gatherRescueContactAvailability
} = require('../src/report');
const { RESCUE_ANCHOR_PREFIX, RESCUE_ANCHOR_NORMALIZED_PREFIX } = require('../src/people');
const { normalize } = require('../src/names');
const { buildStatsPageHtml } = require('../src/adminStats');

// -------------------------------------------------------------- suppressedCell

test('suppressedCell: 0 sale tal cual, 1-4 detrás de "<5", 5+ exacto', () => {
  assert.deepEqual(suppressedCell(0), { value: 0, display: '0', suppressed: false, hidden: false });
  for (const v of [1, 2, 3, 4]) {
    const c = suppressedCell(v);
    assert.equal(c.display, '&lt;5', `${v} debía mostrarse como &lt;5`);
    assert.equal(c.suppressed, true);
    assert.equal(c.hidden, false);
  }
  assert.equal(suppressedCell(5).display, '5');
  assert.equal(suppressedCell(5).suppressed, false);
  assert.equal(suppressedCell(1234).display, '1.234', 'debía usar el separador de miles de n()');
});

// ---------------------------------------------------------- suppressBreakdown

test('suppressBreakdown: sin partes chicas, todo sale exacto', () => {
  const { cells, total } = suppressBreakdown(
    [
      { key: 'a', value: 10 },
      { key: 'b', value: 20 }
    ],
    30
  );
  assert.equal(cells[0].display, '10');
  assert.equal(cells[1].display, '20');
  assert.equal(total.display, '30');
  assert.ok(!cells.some((c) => c.hidden), 'nada debía ocultarse secundariamente');
});

test('suppressBreakdown: UNA parte chica + total exacto → una segunda parte se oculta para que no se pueda deducir por resta', () => {
  const { cells, total } = suppressBreakdown(
    [
      { key: 'chica', value: 2 },
      { key: 'cero', value: 0 },
      { key: 'grande', value: 50 }
    ],
    52
  );
  const byKey = Object.fromEntries(cells.map((c) => [c.key, c]));
  assert.equal(byKey.chica.suppressed, true);
  assert.equal(byKey.chica.hidden, false, 'la parte originalmente chica se queda como "<5", no "oculta"');
  assert.equal(byKey.chica.display, '&lt;5');

  assert.equal(byKey.cero.display, '0', 'un cero real no se toca ni se usa como candidato a ocultar');

  assert.equal(byKey.grande.hidden, true, 'la única parte exacta y positiva que quedaba debía ocultarse');
  assert.equal(byKey.grande.display, '—');
  assert.notEqual(byKey.grande.display, '50', 'el valor real de la parte ocultada nunca debe aparecer en el display');

  assert.equal(total.display, '52', 'el total en sí sigue siendo seguro de mostrar — no es una celda pequeña');

  // Ninguna combinación visible permite reconstruir el 2 exacto: total (52) −
  // cero (0) = 52, repartido entre "chica" (1-4, por construcción) y
  // "grande" (oculta, valor real desconocido para quien lee la página) — sin
  // el valor real de "grande" no hay una única solución.
});

test('suppressBreakdown: DOS partes chicas → ninguna se toca de más (el total no resuelve dos incógnitas)', () => {
  const { cells, total } = suppressBreakdown(
    [
      { key: 'a', value: 2 },
      { key: 'b', value: 3 },
      { key: 'c', value: 45 }
    ],
    50
  );
  const byKey = Object.fromEntries(cells.map((c) => [c.key, c]));
  assert.equal(byKey.a.suppressed, true);
  assert.equal(byKey.a.hidden, false);
  assert.equal(byKey.b.suppressed, true);
  assert.equal(byKey.b.hidden, false);
  assert.equal(byKey.c.suppressed, false, 'con dos partes ya suprimidas, la tercera no necesita ocultarse');
  assert.equal(byKey.c.display, '45');
  assert.equal(total.display, '50');
});

test('suppressBreakdown: si el total mismo es chico, ni siquiera se evalúa la supresión secundaria', () => {
  const { total } = suppressBreakdown([{ key: 'a', value: 2 }, { key: 'b', value: 1 }], 3);
  assert.equal(total.suppressed, true);
  assert.equal(total.display, '&lt;5');
});

// -------------------------------------------------------- RESCUE_ANCHOR_PREFIX

test('RESCUE_ANCHOR_PREFIX/RESCUE_ANCHOR_NORMALIZED_PREFIX no se desincronizan', () => {
  const example = `${RESCUE_ANCHOR_PREFIX}a1b2c3`;
  assert.ok(
    normalize(example).startsWith(RESCUE_ANCHOR_NORMALIZED_PREFIX.trim()),
    'el nombre real que crea POST /rescate debe normalizarse al mismo prefijo que usa report.js para contarlo'
  );
});

// ---------------------------------------------------------------- gather*

async function seededStore() {
  const adapter = await createSqliteAdapter(':memory:');
  return createStore(adapter);
}

test('gatherDuplicateBreakdown: cuenta fichas que NO fueron la primera actualización de su persona, por fuente', async () => {
  const store = await seededStore();
  try {
    const { person: p1 } = await store.findOrCreatePerson('Wilmer Alexander Zapata Ceballos');
    await store.addUpdate(p1.id, { status: 'missing', source: 'web' }); // primera — no cuenta
    await store.addUpdate(p1.id, { status: 'missing', source: 'aggregator', externalId: 'ext-a' }); // segunda — cuenta, aggregator
    await store.addUpdate(p1.id, { status: 'safe', source: 'web' }); // tercera — cuenta, web

    // Nombre deliberadamente MUY distinto del anterior — el fuzzy-matching
    // de findOrCreatePerson (>=0.85 por nombre) fusiona nombres parecidos, y
    // "Persona Duplicados Uno/Dos" comparten dos de tres tokens y sí se
    // fusionaban en la prueba (bug de la prueba, no del código: se detectó
    // corriendo el seed a mano).
    const { person: p2, created } = await store.findOrCreatePerson('Yesenia Del Carmen Ortiz Mosquera');
    assert.ok(created, 'los dos nombres del seed deben crear personas DISTINTAS para que la prueba mida lo que dice medir');
    await store.addUpdate(p2.id, { status: 'missing', source: 'aggregator', externalId: 'ext-b' }); // primera — no cuenta

    const result = await gatherDuplicateBreakdown(store);
    assert.equal(result.total, 2);
    assert.equal(result.bySource.web, 1);
    assert.equal(result.bySource.aggregator, 1);
    assert.equal(result.bySource.whatsapp, 0);
    assert.equal(result.bySource.api, 0);
    assert.equal(result.bySource.rescate, 0);
  } finally {
    await store.close();
  }
});

test('gatherRescuedPeopleCount: solo cuenta personas ancla del flujo de rescate, no cualquier foto de consulta', async () => {
  const store = await seededStore();
  try {
    const { person: rescued1 } = await store.findOrCreatePerson(`${RESCUE_ANCHOR_PREFIX}aaaaaa`);
    await store.addPhoto({ personId: rescued1.id, kind: 'query', content: Buffer.alloc(0), contentType: 'image/jpeg' });
    const { person: rescued2 } = await store.findOrCreatePerson(`${RESCUE_ANCHOR_PREFIX}bbbbbb`);
    await store.addPhoto({ personId: rescued2.id, kind: 'query', content: Buffer.alloc(0), contentType: 'image/jpeg' });

    // Una persona YA reportada (no del flujo de rescate) a la que alguien se
    // suscribe con una foto de consulta (POST /api/people/:id/subscriptions)
    // — no debe contar como "fotografiada por un rescatista".
    const { person: searched } = await store.findOrCreatePerson('Persona Buscada Por Familia');
    await store.addUpdate(searched.id, { status: 'missing', source: 'web' });
    await store.addPhoto({ personId: searched.id, kind: 'query', content: Buffer.alloc(0), contentType: 'image/jpeg' });

    const count = await gatherRescuedPeopleCount(store);
    assert.equal(count, 2);
  } finally {
    await store.close();
  }
});

test('gatherSimilarityTierBreakdown: clasifica por tramo y superficie, deja afuera null y <90 sin inventarles tramo', async () => {
  const store = await seededStore();
  try {
    const { person } = await store.findOrCreatePerson('Persona Tramos');
    const rows = [
      { similarity: 100, surface: 'rescate' },
      { similarity: 99.9998, surface: 'rescate' }, // redondeo de Rekognition, cuenta como 100
      { similarity: 99.5, surface: 'report' },
      { similarity: 96.4, surface: 'api' },
      { similarity: 91, surface: 'rescate' },
      { similarity: 85, surface: 'report' }, // histórico, por debajo del umbral actual
      { similarity: null, surface: 'api' } // sin puntaje guardado
    ];
    for (const r of rows) {
      await store.insertMatchLog({ personId: person.id, updateId: null, faceId: `f-${Math.random()}`, similarity: r.similarity, surface: r.surface });
    }

    const result = await gatherSimilarityTierBreakdown(store);
    assert.equal(result.tiers['100'].total, 2);
    assert.equal(result.tiers['100'].bySurface.rescate, 2);
    assert.equal(result.tiers['99-99.9'].total, 1);
    assert.equal(result.tiers['99-99.9'].bySurface.report, 1);
    assert.equal(result.tiers['95-99'].total, 1);
    assert.equal(result.tiers['95-99'].bySurface.api, 1);
    assert.equal(result.tiers['90-95'].total, 1);
    assert.equal(result.tiers['90-95'].bySurface.rescate, 1);
    assert.equal(result.belowThreshold, 1);
    assert.equal(result.missingScore, 1);
  } finally {
    await store.close();
  }
});

test('gatherRescueContactAvailability: separa a los rescatistas que dejaron contacto de los que no, sin tocar a quien no es del flujo de rescate', async () => {
  const store = await seededStore();
  try {
    // Dos rescates SIN contacto (sub == null): el caso que #132 llama "el más
    // común hoy y correcto" — nadie a quien avisar si la foto llega a
    // coincidir. Sufijos deliberadamente MUY distintos entre sí — el
    // fuzzy-matching de findOrCreatePerson (>=0.85 por nombre) fusiona
    // nombres parecidos, y "sin1"/"sin2" comparten casi todo el nombre (ver
    // el mismo aviso en test/admin-stats.test.js).
    const { person: sinContacto1 } = await store.findOrCreatePerson(`${RESCUE_ANCHOR_PREFIX}aaaaaa`);
    await store.addPhoto({ personId: sinContacto1.id, kind: 'query', content: Buffer.alloc(0), contentType: 'image/jpeg' });
    const { person: sinContacto2 } = await store.findOrCreatePerson(`${RESCUE_ANCHOR_PREFIX}bbbbbb`);
    await store.addPhoto({ personId: sinContacto2.id, kind: 'query', content: Buffer.alloc(0), contentType: 'image/jpeg' });

    // Un rescate CON contacto: dejó correo, así que la foto de consulta queda
    // atada a esa suscripción.
    const { person: conContacto } = await store.findOrCreatePerson(`${RESCUE_ANCHOR_PREFIX}cccccc`);
    const { sub } = await store.subscribe(conContacto.id, 'email', 'rescatista@ejemplo.com');
    await store.addPhoto({
      personId: conContacto.id,
      kind: 'query',
      subscriptionId: sub.id,
      content: Buffer.alloc(0),
      contentType: 'image/jpeg'
    });

    // Una persona ya reportada (no es una persona ancla de rescate) con su
    // propia foto de consulta sin suscripción — no debe colarse en ninguno
    // de los dos conteos.
    const { person: searched } = await store.findOrCreatePerson('Persona Buscada Por Familia');
    await store.addUpdate(searched.id, { status: 'missing', source: 'web' });
    await store.addPhoto({ personId: searched.id, kind: 'query', content: Buffer.alloc(0), contentType: 'image/jpeg' });

    const result = await gatherRescueContactAvailability(store);
    assert.equal(result.withoutContact, 2);
    assert.equal(result.withContact, 1);
    assert.equal(result.total, 3);
  } finally {
    await store.close();
  }
});

// ----------------------------------------- Postgres: forma del SQL (sin DB real)
async function withFakePostgresAdapter(run) {
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
  require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: FakePool } };
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

test('Postgres: updatesBeyondFirstBySource usa ROW_NUMBER particionado por persona, no un LIMIT/OFFSET a mano', async () => {
  await withFakePostgresAdapter(async (adapter, statements) => {
    await adapter.updatesBeyondFirstBySource();
    const sql = statements.find((s) => /FROM updates/.test(s) && /ROW_NUMBER/.test(s));
    assert.ok(sql, 'debía emitirse la consulta de updatesBeyondFirstBySource');
    assert.match(sql, /PARTITION BY person_id/);
    assert.match(sql, /GROUP BY source/);
    assert.match(sql, /WHERE rn > 1/);
  });
});

test('Postgres: queryPhotoPeople filtra por kind=query y no trae ninguna columna con forma de PII', async () => {
  await withFakePostgresAdapter(async (adapter, statements) => {
    await adapter.queryPhotoPeople();
    const sql = statements.find((s) => /FROM photos/.test(s) && /JOIN people/.test(s));
    assert.ok(sql, 'debía emitirse la consulta de queryPhotoPeople');
    assert.match(sql, /kind = 'query'/);
    assert.doesNotMatch(sql, /full_name/i, 'no debe seleccionar el nombre completo — solo el normalizado, para clasificar');
  });
});

test('Postgres: queryPhotoPeople (#132, punto 5) trae subscription_id agregado con MAX + GROUP BY, no DISTINCT — una fila por persona', async () => {
  await withFakePostgresAdapter(async (adapter, statements) => {
    await adapter.queryPhotoPeople();
    const sql = statements.find((s) => /FROM photos/.test(s) && /JOIN people/.test(s));
    assert.match(sql, /MAX\(ph\.subscription_id\)/, 'debía traer subscription_id agregado con MAX, no crudo — para no multiplicar filas por persona');
    assert.match(sql, /GROUP BY ph\.person_id, p\.normalized_name/);
    assert.doesNotMatch(sql, /DISTINCT/, 'el DISTINCT viejo ya no aplica — GROUP BY es lo que garantiza una fila por persona ahora que hay una tercera columna');
  });
});

test('Postgres: matchLogSimilarityRows trae solo similarity y surface', async () => {
  await withFakePostgresAdapter(async (adapter, statements) => {
    await adapter.matchLogSimilarityRows();
    const sql = statements.find((s) => /FROM match_log/.test(s) && /SELECT similarity, surface/.test(s));
    assert.ok(sql, 'debía emitirse una consulta que solo pide similarity y surface');
  });
});

// ------------------------------------------------- buildStatsPageHtml (#132)
//
// Regresión real, encontrada renderizando el panel contra `npm run seed`
// antes de abrir este PR: la primera versión del desglose de duplicados por
// canal aplicaba supresión CELDA POR CELDA (suppressedCell), no
// suppressBreakdown — con el total exacto de al lado, una sola fuente chica
// quedaba deducible por resta de las demás. Este test fija el arreglo.
// `rescueContact`/`reunitedCount` (#132, punto 5-6) tienen un default no-cero
// para que los tests viejos (que no los pasan) sigan probando lo que decían
// probar, en vez de reventar contra un `extras.rescueContact.withoutContact`
// de un `undefined`.
function minimalPanelInputs(extras) {
  return {
    data: {
      generatedAt: new Date('2026-08-13T12:00:00Z'),
      counts: { people: 500, updates: 700, subscriptions: 200, subscriptions_verified: 150, photos: 600, photos_indexed: 580 },
      activity: {
        match: { total: 100, rescate: 40, report: 40, api: 20 },
        contact: [],
        since: null,
        instrumentedSince: { match: null, contact: null }
      },
      matcherStatus: 'activo (fake)',
      extras: {
        duplicates: { total: 47, bySource: { web: 36, whatsapp: 2, api: 0, aggregator: 9, rescate: 0 } },
        rescuedPeople: 40,
        similarity: {
          tiers: {
            '100': { label: '100%', bySurface: { rescate: 0, report: 0, api: 0 }, total: 0 },
            '99-99.9': { label: '99–99,9%', bySurface: { rescate: 0, report: 0, api: 0 }, total: 0 },
            '95-99': { label: '95–99%', bySurface: { rescate: 0, report: 0, api: 0 }, total: 0 },
            '90-95': { label: '90–95%', bySurface: { rescate: 0, report: 0, api: 0 }, total: 0 }
          },
          belowThreshold: 0,
          missingScore: 0
        },
        rescueContact: { withContact: 25, withoutContact: 60, total: 85 },
        reunitedCount: 30,
        ...extras
      }
    },
    daily: []
  };
}

test('buildStatsPageHtml: el desglose de duplicados por canal no deja deducir una fuente chica por resta del total', () => {
  const extras = {
    duplicates: { total: 47, bySource: { web: 36, whatsapp: 2, api: 0, aggregator: 9, rescate: 0 } },
    rescuedPeople: 40,
    similarity: {
      tiers: {
        '100': { label: '100%', bySurface: { rescate: 0, report: 0, api: 0 }, total: 0 },
        '99-99.9': { label: '99–99,9%', bySurface: { rescate: 0, report: 0, api: 0 }, total: 0 },
        '95-99': { label: '95–99%', bySurface: { rescate: 0, report: 0, api: 0 }, total: 0 },
        '90-95': { label: '90–95%', bySurface: { rescate: 0, report: 0, api: 0 }, total: 0 }
      },
      belowThreshold: 0,
      missingScore: 0
    }
  };
  const { data, daily } = minimalPanelInputs(extras);
  const html = buildStatsPageHtml(data, daily, { isPublic: true });

  assert.match(html, /&lt;5/, 'la fuente chica (whatsapp=2) debía salir como &lt;5');
  assert.match(html, />36</, 'la fuente grande y segura (web=36) sí puede salir exacta');
  assert.ok(!/>9</.test(html), 'la fuente que hacía deducible a whatsapp por resta (aggregator=9) NO debe salir exacta — debe quedar oculta');
  assert.match(html, />—</, 'debía aparecer al menos una celda oculta ("—") protegiendo a la fuente chica');
});

test('buildStatsPageHtml: un total pequeño de coincidencias al 100% también se suprime, no solo el desglose por superficie', () => {
  const extras = {
    duplicates: { total: 0, bySource: { web: 0, whatsapp: 0, api: 0, aggregator: 0, rescate: 0 } },
    rescuedPeople: 0,
    similarity: {
      tiers: {
        '100': { label: '100%', bySurface: { rescate: 2, report: 0, api: 0 }, total: 2 },
        '99-99.9': { label: '99–99,9%', bySurface: { rescate: 0, report: 0, api: 0 }, total: 0 },
        '95-99': { label: '95–99%', bySurface: { rescate: 0, report: 0, api: 0 }, total: 0 },
        '90-95': { label: '90–95%', bySurface: { rescate: 0, report: 0, api: 0 }, total: 0 }
      },
      belowThreshold: 3,
      missingScore: 0
    }
  };
  const { data, daily } = minimalPanelInputs(extras);
  const html = buildStatsPageHtml(data, daily, { isPublic: true });

  // Acotado a la sección de tramos: el resto de la página (ejes de las
  // gráficas SVG, por ejemplo) sí puede contener un "2" o un "3" sueltos sin
  // que eso sea el dato real — el chequeo que importa es DENTRO de esta
  // sección.
  const start = html.indexOf('Coincidencias por tramo de confianza');
  const end = html.indexOf('El umbral del matcher es 90%');
  assert.ok(start >= 0 && end > start, 'la sección de tramos debía existir');
  const section = html.slice(start, end);

  assert.ok(!/>2</.test(section), 'el 2 real de coincidencias al 100% nunca debe salir exacto dentro de la sección de tramos');
  assert.match(html, /&lt;5[^<]*coincidencia\(s\) histórica\(s\)/, 'las 3 coincidencias históricas por debajo del umbral deben salir suprimidas, no exactas');
  // La alarma de calidad solo se dispara con datos reales (>0), pero nunca
  // con el número real.
  assert.match(html, /alguien usó el formulario equivocado/);
});

// --------------------------------------- buildStatsPageHtml: puntos 5-6 (#132)

test('buildStatsPageHtml: "nadie a quien avisar" se explica con las palabras del issue — caso más común y correcto, no una falla', () => {
  const extras0 = { rescueContact: { withContact: 12, withoutContact: 88, total: 100 }, reunitedCount: 5 };
  const { data, daily } = minimalPanelInputs(extras0);
  const html = buildStatsPageHtml(data, daily, { isPublic: true });

  const start = html.indexOf('Qué pasó después de cada coincidencia');
  const end = html.indexOf('El embudo del encuentro');
  assert.ok(start >= 0 && end > start, 'la sección del punto 5 debía existir');
  const section = html.slice(start, end);

  assert.match(section, />88</, 'el total (100) y las partes (88/12) están arriba del umbral de supresión, así que salen exactas');
  assert.match(section, />12</);
  assert.match(section, /MÁS COMÚN/, 'el issue exige decir explícitamente que es el caso más común');
  assert.match(section, /correcto/i, 'y que es comportamiento CORRECTO, no una falla');
  assert.match(section, /nunca le escribe a un número o correo que nadie confirmó/i);
});

test('buildStatsPageHtml: la supresión protege tanto "nadie a quien avisar" como el desglose de avisos por resultado', () => {
  // Un solo rescate sin contacto (1-4) junto a un total mayor: el candidato a
  // supresión secundaria es "conContacto".
  const extras = {
    rescueContact: { withContact: 40, withoutContact: 2, total: 42 },
    reunitedCount: 3 // 1-4 también, para probar el escalón 4 del embudo
  };
  const { data, daily } = minimalPanelInputs(extras);
  const html = buildStatsPageHtml(data, daily, { isPublic: true });

  const start = html.indexOf('Qué pasó después de cada coincidencia');
  const end = html.indexOf('El embudo del encuentro');
  const section = html.slice(start, end);

  assert.match(section, /&lt;5/, 'el "sin contacto"=2 debe salir como <5');
  assert.ok(!/>40</.test(section), 'con el total exacto (42) al lado, el "con contacto"=40 sería deducible por resta y debe quedar oculto');
  assert.match(section, />—</, 'debía aparecer al menos una celda oculta protegiendo al "sin contacto"');
});

test('buildStatsPageHtml: el embudo del encuentro es acumulado, dice "PISO, no un total", y reusa las MISMAS celdas que el resto de la página', () => {
  const extras = {
    rescueContact: { withContact: 25, withoutContact: 60, total: 85 },
    reunitedCount: 17
  };
  const { data, daily } = minimalPanelInputs(extras);
  const html = buildStatsPageHtml(data, daily, { isPublic: true });

  const start = html.indexOf('El embudo del encuentro (acumulado)');
  assert.ok(start >= 0, 'la sección del punto 6 debía existir');
  const section = html.slice(start);

  assert.match(section, /PISO, no un total/, 'la honestidad del piso es un requisito del issue, no un nice-to-have');
  assert.match(section, /La app no puede ver el abrazo/i);
  assert.match(section, /100/, 'escalón 1 (registrada) debe mostrar el total de coincidencias, 100');
  assert.match(section, />40</, 'escalón 2 (entregada) debe mostrar SOLO las de superficie rescate (40), la misma cifra del hero card de arriba');
  assert.match(section, />17</, 'escalón 4 (a salvo) debe mostrar reunitedCount tal cual, arriba del umbral de supresión');

  // Nunca por día: la palabra "día" no debe aparecer describiendo el embudo.
  assert.ok(!/embudo del encuentro[\s\S]{0,400}por día/i.test(section), 'el embudo del encuentro es acumulado, nunca rebanado por día');
});

test('buildStatsPageHtml: el escalón 4 del embudo (a salvo) también respeta la supresión de celdas pequeñas', () => {
  const extras = {
    rescueContact: { withContact: 25, withoutContact: 60, total: 85 },
    reunitedCount: 3 // 1-4
  };
  const { data, daily } = minimalPanelInputs(extras);
  const html = buildStatsPageHtml(data, daily, { isPublic: true });

  const start = html.indexOf('El embudo del encuentro (acumulado)');
  const section = html.slice(start);
  assert.match(section, /&lt;5/, 'reunitedCount=3 debía salir como <5, nunca "3" exacto');
  assert.ok(!/>3</.test(section), 'el 3 real nunca debe aparecer exacto en esta sección');
});
