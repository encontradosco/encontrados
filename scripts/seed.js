#!/usr/bin/env node
// Datos sintéticos para desarrollar en local — `npm run seed`.
//
// POR QUÉ EXISTE: el repo promete (y cumple) que se desarrolla sin ninguna
// credencial, sobre SQLite. Pero la base local arranca VACÍA, así que
// /admin/stats renderiza ceros y nadie puede iterar sobre un panel que no
// muestra nada. Peor: un agente que no ve datos se inventa lo que no ve. Esto
// llena la base con suficiente forma para que CADA cifra del panel tenga algo
// que mostrar — incluidas las que solo se ven cuando algo sale mal.
//
// QUÉ NO ES: no es una réplica de producción ni una aproximación a ella. Los
// volúmenes son los mínimos para que el panel se lea, no los reales. Nada de
// lo que hay acá describe a una persona: los nombres son sintéticos a
// propósito (la misma regla que rige los tests), los teléfonos no son números
// asignables y los correos van a `ejemplo.com`.
//
// SE NIEGA A CORRER contra Postgres, contra Vercel y con NODE_ENV=production.
// Sembrar datos falsos en la base de una emergencia real es el peor accidente
// que este archivo podría causar, así que la negativa es ruidosa y es lo
// primero que pasa — antes de abrir nada.
//
// IDEMPOTENTE: cada fila que escribe queda marcada (`external_id` que empieza
// con `seed:`, `face_id` que empieza con `seed-`). Correrlo dos veces borra lo
// suyo y vuelve a sembrar; lo que hayas creado a mano probando no se toca.

const Database = require('better-sqlite3');
const sharp = require('sharp');

// Cargar .env ANTES del guard, a propósito: si alguien tiene un DATABASE_URL
// de producción ahí, el guard tiene que verlo.
const env = require('../src/env');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createStore } = require('../src/people');

// ---------------------------------------------------------------------------
// El guard
// ---------------------------------------------------------------------------

// Los mismos nombres que reconoce src/store/index.js para elegir Postgres. Si
// cualquiera está puesta, la app NO usaría SQLite — y este script solo sabe
// sembrar en local.
const NOMBRES_POSTGRES = [
  'DATABASE_URL',
  'POSTGRES_URL',
  'STORAGE_URL',
  'STORAGE_POSTGRES_URL',
  'NEON_DATABASE_URL',
  'POSTGRES_PRISMA_URL'
];

// Devuelve la lista de razones por las que este entorno NO es local. Vacía =
// se puede sembrar.
function razonesParaNegarse(entorno = process.env) {
  const razones = [];
  for (const nombre of NOMBRES_POSTGRES) {
    if (entorno[nombre]) razones.push(`${nombre} está definida — esta base es Postgres, no la local.`);
  }
  // Y el barrido general: el nombre de la variable puede ser cualquiera (la
  // integración de Vercel inventa prefijos), pero el valor siempre delata.
  for (const [nombre, valor] of Object.entries(entorno)) {
    if (NOMBRES_POSTGRES.includes(nombre)) continue;
    if (typeof valor === 'string' && /^postgres(ql)?:\/\//i.test(valor.trim())) {
      razones.push(`${nombre} contiene una cadena de conexión a Postgres.`);
    }
  }
  if (entorno.VERCEL) razones.push('VERCEL está definida — esto corre dentro de un deployment, no en tu máquina.');
  if (entorno.NODE_ENV === 'production') razones.push('NODE_ENV=production.');
  return razones;
}

// ---------------------------------------------------------------------------
// Los nombres
// ---------------------------------------------------------------------------

// Todos los nombres son "Persona Prueba <sustantivo>". El sustantivo es una
// cosa, nunca un apellido: así ninguna combinación puede coincidir con alguien
// real, ni siquiera por casualidad.
//
// Los sustantivos están escogidos para estar LEJOS entre sí según el propio
// matcher del repo (src/names.js): dos nombres que solo difieran en un token
// parecido (distancia ≤2, o uno prefijo del otro) se fusionarían solos y el
// seed produciría menos personas de las que cree. El script lo verifica en
// caliente y revienta nombrando el par culpable si eso pasa — ver
// `crearPersonasBase`.
const SUSTANTIVOS = [
  'ventana', 'bicicleta', 'volcan', 'cuaderno', 'semaforo', 'tornillo',
  'guitarra', 'almohada', 'relampago', 'cerradura', 'girasol', 'pantalla',
  'escalera', 'murcielago', 'tobogan', 'alfombra', 'brujula', 'chimenea',
  'quebrada', 'telescopio', 'invierno', 'buzon', 'cascada', 'molino',
  'sombrilla', 'trompeta', 'ladrillo', 'esponja', 'granizo', 'hormiga',
  'jarabe', 'kiosco', 'linterna', 'mandarina', 'nebulosa', 'obelisco',
  'pergamino', 'sortija', 'sendero', 'trebol', 'ukelele', 'vitrina',
  'xilofono', 'yunque', 'zafiro', 'abanico', 'colibri', 'embudo',
  'fogata', 'hebilla', 'helecho', 'imprenta', 'jazmin', 'kayak',
  'columpio', 'naipe', 'orquidea', 'piragua', 'racimo', 'tejado',
  'urdimbre', 'veleta', 'wafle', 'zanahoria'
];

// Municipios del Chocó y del eje afectado. Geografía pública: un lugar no es
// un dato personal.
const LUGARES = [
  'Quibdó, Chocó', 'Istmina, Chocó', 'Condoto, Chocó', 'Nuquí, Chocó',
  'Bahía Solano, Chocó', 'Tadó, Chocó', 'Riosucio, Chocó', 'Acandí, Chocó',
  'Bojayá, Chocó', 'Lloró, Chocó', 'Medio Atrato, Chocó', 'Unión Panamericana, Chocó'
];

// ---------------------------------------------------------------------------
// Volúmenes
// ---------------------------------------------------------------------------
//
// Cada número de acá está puesto para que una cifra del panel se pueda LEER.
// El panel suprime los conteos entre 1 y 4 (los muestra como `<5`, porque un
// uno describe a una persona), así que casi todo va por encima de 4 —
// y unas pocas celdas van a propósito por debajo, para que la supresión
// también se vea funcionando.

const DIAS = 10; // ventana de fechas; el panel grafica los últimos 7
const PERSONAS_BASE = 64; // personas únicas reportadas
const FICHAS_DUPLICADAS = 18; // fichas extra que se fusionan con una existente
const ANCLAS_RESCATE = 26; // consultas de rescatista (el otro lado del cruce)
const ANCLAS_API = 5; // consultas por API
const PERSONAS_CON_FOTO = 52; // de las reportadas
const FOTOS_SIN_INDEXAR = 8; // de esas, las que no llegaron al índice facial
const FAMILIARES_SUSCRITOS = 34; // familiares que pidieron aviso

// Estado final de cada persona reportada. `safe` es el último escalón del
// embudo del encuentro: sin estas filas ese escalón siempre es cero.
const ESTADOS_FINALES = { safe: 9, injured: 7, deceased: 5, unknown: 6 };
// el resto queda en `missing`

// Coincidencias por tramo de similitud × superficie. El umbral del matcher es
// 90, así que NUNCA hay nada por debajo: un tramo inferior sería siempre cero
// y mentiría por omisión.
const COINCIDENCIAS = [
  // [tramo, min, max, { rescate, report, api }]
  ['100%', 100, 100, { rescate: 3, report: 2, api: 2 }],
  ['99–99,9%', 99, 99.9, { rescate: 7, report: 4, api: 1 }],
  ['95–99%', 95, 98.99, { rescate: 30, report: 14, api: 2 }],
  ['90–95%', 90, 94.99, { rescate: 13, report: 7, api: 1 }]
];

// Envíos por canal × resultado. Los fallos van primero en el panel a
// propósito, así que tiene que haber fallos que ver.
const ENVIOS = {
  email: { enviado: 24, fallido: 6, rechazado: 5 },
  whatsapp: { enviado: 18, fallido: 7, rechazado: 3 },
  relevo: { enviado: 31, fallido: 5, rechazado: 2 }
};

// ---------------------------------------------------------------------------
// Azar reproducible
// ---------------------------------------------------------------------------

// PRNG propio, sin dependencias: dos corridas del seed producen la misma
// forma. Un seed que cambia de forma en cada corrida no sirve para comparar
// "¿esto lo rompí yo o ya estaba?".
function prng(semilla) {
  let a = semilla >>> 0;
  return function siguiente() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------

const OFFSET_BOGOTA_MS = 5 * 3600 * 1000; // Colombia no tiene horario de verano

// Instante UTC (formato ISO, el mismo que usa el esquema) para una hora de
// BOGOTÁ de hace `diasAtras` días.
//
// Existe para poder generar a propósito lo que rompe: el panel agrupa los días
// en hora de Bogotá, no UTC, y las 23:00 de Bogotá son las 04:00 UTC del día
// SIGUIENTE. Si alguien vuelve a agrupar por UTC, esas filas se van a la fila
// equivocada de la serie diaria y se nota. Sin datos en esa franja, el bug es
// invisible hasta que lo ve un usuario.
function instanteBogota(diasAtras, hora, minuto = 0) {
  const ahoraBogota = new Date(Date.now() - OFFSET_BOGOTA_MS);
  const dia = new Date(
    Date.UTC(
      ahoraBogota.getUTCFullYear(),
      ahoraBogota.getUTCMonth(),
      ahoraBogota.getUTCDate() - diasAtras,
      hora,
      minuto,
      0
    )
  );
  return new Date(dia.getTime() + OFFSET_BOGOTA_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Horas del día que usa el seed. Las dos últimas y la primera están pegadas a
// la frontera de día de Bogotá a propósito (ver instanteBogota).
const HORAS_DEL_DIA = [0, 7, 9, 11, 14, 16, 18, 20, 23, 23];
const MINUTOS_DEL_DIA = [20, 15, 40, 5, 30, 50, 10, 35, 10, 45];

// Reparte `cuantos` instantes entre hace `desde` días y hace `hasta` días,
// pasando siempre por la frontera de Bogotá.
function repartirFechas(cuantos, azar, { desde = DIAS - 1, hasta = 0 } = {}) {
  const ventana = desde - hasta + 1;
  const fechas = [];
  for (let i = 0; i < cuantos; i++) {
    const diasAtras = desde - Math.floor((i / cuantos) * ventana);
    const h = Math.floor(azar() * HORAS_DEL_DIA.length);
    fechas.push(instanteBogota(diasAtras, HORAS_DEL_DIA[h], MINUTOS_DEL_DIA[h]));
  }
  return fechas.sort();
}

// ---------------------------------------------------------------------------
// Imágenes
// ---------------------------------------------------------------------------

// Cuadros de color plano, no caras. Que se vean inconfundiblemente sintéticos
// es una característica: nadie puede confundir el seed con datos reales de un
// pantallazo. Se generan ocho y se reciclan — sharp es la parte cara de todo
// esto y no hay ninguna razón para pagarla 80 veces.
async function generarImagenes() {
  const colores = [
    { r: 198, g: 122, b: 92 }, { r: 92, g: 128, b: 168 }, { r: 122, g: 158, b: 108 },
    { r: 176, g: 148, b: 96 }, { r: 148, g: 108, b: 156 }, { r: 96, g: 152, b: 156 },
    { r: 186, g: 116, b: 128 }, { r: 128, g: 136, b: 108 }
  ];
  return Promise.all(
    colores.map((background) =>
      sharp({ create: { width: 480, height: 480, channels: 3, background } })
        .jpeg({ quality: 60 })
        .toBuffer()
    )
  );
}

// Geometría de detección plausible, para que la miniatura y el recuadro del
// listado público tengan qué recortar.
const GEOMETRIA = { box: { l: 0.3, t: 0.22, w: 0.4, h: 0.42 } };

// ---------------------------------------------------------------------------
// Limpieza
// ---------------------------------------------------------------------------

// Borra SOLO lo que sembró una corrida anterior. Las personas sembradas se
// reconocen por su marca (`external_id` `seed:…` en una actualización, o
// `face_id` `seed-…` en una foto) y el ON DELETE CASCADE de people(id) se
// lleva actualizaciones, fotos, suscripciones y las dos bitácoras.
function limpiar(db) {
  const ids = db
    .prepare(
      `SELECT DISTINCT person_id AS id FROM updates WHERE external_id LIKE 'seed:%'
       UNION
       SELECT DISTINCT person_id AS id FROM photos WHERE face_id LIKE 'seed-%'`
    )
    .all()
    .map((r) => r.id);
  if (!ids.length) return 0;
  const marcas = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM people WHERE id IN (${marcas})`).run(...ids);
  return ids.length;
}

// ---------------------------------------------------------------------------
// Siembra
// ---------------------------------------------------------------------------

function telefono(i) {
  // Prefijo real pero abonado no asignable: es un relleno, no el número de
  // nadie.
  return `+57 300 000 ${String(1000 + i).slice(-4)}`;
}

function hex(i) {
  // Termina en dígito para que titleCaseName lo reconozca como etiqueta
  // generada (isGeneratedLabel) y no lo convierta en "Nombre Propio".
  return `${(i * 7919).toString(16).padStart(5, '0').slice(-5)}${i % 10}`;
}

// Variantes de un nombre que el matcher DEBE fusionar con el original.
// Cada una ataca una vía distinta de las que el repo usa de verdad:
//   0 — idéntico            → exactByNormalized
//   1 — sin tilde/mayúsculas → normalize
//   2 — b por v             → clave fonética
//   3 — un carácter de más  → distancia de edición
function variante(nombre, i) {
  switch (i % 4) {
    case 0:
      return nombre;
    case 1:
      return nombre.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    case 2:
      return nombre.replace(/v/g, 'b');
    default:
      return nombre.replace(/(.)$/, '$1$1');
  }
}

async function crearPersonasBase(store, azar, registrar) {
  const personas = [];
  // Las fichas iniciales quedan en la mitad vieja de la ventana; los cierres
  // (abajo) en la reciente, para que el estado más nuevo de una persona sea
  // siempre el que el seed dice que es.
  const fechas = repartirFechas(PERSONAS_BASE, azar, { desde: DIAS - 1, hasta: 3 });

  // Estado final por persona, barajado de forma determinista.
  const estados = [];
  for (const [estado, cuantos] of Object.entries(ESTADOS_FINALES)) {
    for (let i = 0; i < cuantos; i++) estados.push(estado);
  }
  while (estados.length < PERSONAS_BASE) estados.push('missing');
  for (let i = estados.length - 1; i > 0; i--) {
    const j = Math.floor(azar() * (i + 1));
    [estados[i], estados[j]] = [estados[j], estados[i]];
  }

  for (let i = 0; i < PERSONAS_BASE; i++) {
    const nombre = `Persona Prueba ${SUSTANTIVOS[i]}`;
    const { person, created } = await store.findOrCreatePerson(nombre);
    if (!created) {
      // El banco de sustantivos se cruzó consigo mismo: dos nombres quedaron a
      // menos de 0.85 y el matcher los fusionó. Sin esto el seed produciría en
      // silencio menos personas de las que dice producir.
      throw new Error(
        `El nombre «${nombre}» se fusionó con «${person.full_name}» — el banco de sustantivos ` +
          'tiene dos entradas demasiado parecidas. Cambia una de las dos en SUSTANTIVOS.'
      );
    }
    const fecha = fechas[i];
    const estado = estados[i];
    // La primera ficha siempre entra como `missing` (así se reporta a alguien);
    // el estado final, si es otro, llega después como una segunda actualización.
    const update = await store.addUpdate(person.id, {
      status: 'missing',
      message: 'Ficha sintética de desarrollo. No describe a ninguna persona.',
      location: LUGARES[i % LUGARES.length],
      source: i % 3 === 0 ? 'web' : 'aggregator',
      reporter: `Familiar de prueba ${i + 1}`,
      // Solo algunas fichas traen contacto: el embudo cuenta aparte las
      // coincidencias que no tenían a quién avisar, y ese caso es hoy el más
      // común y es comportamiento correcto, no una falla.
      contact: i % 3 === 0 ? telefono(i) : null,
      externalId: `seed:ficha:${i}`
    });
    registrar.persona(person.id, fecha);
    registrar.update(update.id, fecha);

    let ultimo = update;
    if (estado !== 'missing') {
      const fechaFinal = instanteBogota(Math.floor(azar() * 3), 23, 40);
      const cierre = await store.addUpdate(person.id, {
        status: estado,
        message: 'Actualización sintética de desarrollo.',
        location: LUGARES[(i + 3) % LUGARES.length],
        source: 'web',
        reporter: `Familiar de prueba ${i + 1}`,
        externalId: `seed:cierre:${i}`
      });
      registrar.update(cierre.id, fechaFinal);
      ultimo = cierre;
    }

    personas.push({ ...person, nombre, updateId: ultimo.id, primerUpdateId: update.id, fecha, estado });
  }
  return personas;
}

async function crearFichasDuplicadas(store, personas, azar, registrar) {
  // Antes que los cierres de estado, para que una ficha duplicada («missing»)
  // nunca quede como la actualización más reciente de alguien ya marcado safe.
  const fechas = repartirFechas(FICHAS_DUPLICADAS, azar, { desde: DIAS - 1, hasta: 3 });
  let fusionadas = 0;
  for (let i = 0; i < FICHAS_DUPLICADAS; i++) {
    // Se reparten sobre las primeras personas para que unas cuantas queden con
    // dos fichas extra — que es como llegan de verdad: la misma persona
    // reportada por dos familiares y además publicada por una fuente externa.
    const objetivo = personas[i % 14];
    const nombre = variante(objetivo.nombre, i);
    const { person, created } = await store.findOrCreatePerson(nombre);
    if (created || person.id !== objetivo.id) {
      throw new Error(
        `La ficha duplicada «${nombre}» no se fusionó con «${objetivo.nombre}» ` +
          `(${created ? 'creó una persona nueva' : `cayó en «${person.full_name}»`}). ` +
          'La deduplicación cambió de umbral, o la variante ya no aplica.'
      );
    }
    fusionadas++;
    const update = await store.addUpdate(person.id, {
      status: 'missing',
      message: 'Ficha duplicada sintética — debe fusionarse con la persona existente.',
      location: LUGARES[(i + 5) % LUGARES.length],
      // Mitad de fuentes externas, mitad generados de nuestro lado: el panel
      // cuenta los dos.
      source: i % 2 === 0 ? 'aggregator' : 'web',
      reporter: `Familiar de prueba ${100 + i}`,
      contact: i % 2 === 0 ? telefono(100 + i) : null,
      externalId: `seed:duplicado:${i}`
    });
    registrar.update(update.id, fechas[i]);
  }
  return fusionadas;
}

async function crearFotosDeReporte(store, personas, imagenes, registrar) {
  let indexadas = 0;
  for (let i = 0; i < PERSONAS_CON_FOTO; i++) {
    const persona = personas[i];
    const foto = await store.addPhoto({
      personId: persona.id,
      kind: 'report',
      updateId: persona.primerUpdateId,
      content: imagenes[i % imagenes.length],
      contentType: 'image/jpeg'
    });
    registrar.foto(foto.id, persona.fecha);
    // Las últimas quedan SIN firma facial a propósito: el panel muestra
    // "fotos (en el índice facial)" como dos números distintos, y con todas
    // indexadas ese contraste no se ve.
    if (i < PERSONAS_CON_FOTO - FOTOS_SIN_INDEXAR) {
      await store.setPhotoFaceId(foto.id, `seed-face-r-${i}`);
      await store.setPhotoFaceDetail(foto.id, GEOMETRIA);
      await store.setPhotoThumbnails(foto.id, {
        small: imagenes[i % imagenes.length],
        large: imagenes[i % imagenes.length],
        contentType: 'image/jpeg'
      });
      indexadas++;
      persona.faceId = `seed-face-r-${i}`;
    }
  }
  return indexadas;
}

// El otro lado del cruce: quien encontró a alguien y sube su foto para
// preguntar si la están buscando. En el flujo real esto crea una fila ancla en
// `people` ("Persona rescatada a1b2c3") que NO es una persona reportada, y la
// foto se compara, se indexa su firma y **los bytes se borran**. El seed
// reproduce ese borrado en vez de saltárselo: es la regla de privacidad que
// más fácil se rompe editando por acá.
async function crearConsultas(store, imagenes, azar, registrar) {
  const anclas = [];
  const total = ANCLAS_RESCATE + ANCLAS_API;
  const fechas = repartirFechas(total, azar);
  for (let i = 0; i < total; i++) {
    const esRescate = i < ANCLAS_RESCATE;
    const etiqueta = esRescate ? 'Persona rescatada' : 'Búsqueda por foto';
    const nombre = `${etiqueta} ${hex(i + 1)}`;
    const { person, created } = await store.findOrCreatePerson(nombre);
    if (!created) {
      throw new Error(
        `El ancla «${nombre}» se fusionó con «${person.full_name}» — dos sufijos hex quedaron ` +
          'demasiado parecidos para el matcher. Cambia la fórmula de hex().'
      );
    }
    registrar.persona(person.id, fechas[i]);

    // El rescatista deja contacto a veces, no siempre.
    let subId = null;
    if (esRescate && i % 3 === 0) {
      const { sub } = await store.subscribe(person.id, 'email', `rescatista.prueba.${i}@ejemplo.com`);
      subId = sub.id;
      registrar.suscripcion(sub.id, fechas[i]);
    } else if (esRescate && i % 3 === 1) {
      const { sub } = await store.subscribe(person.id, 'whatsapp', telefono(500 + i), { verified: false });
      subId = sub.id;
      registrar.suscripcion(sub.id, fechas[i]);
    }

    const foto = await store.addPhoto({
      personId: person.id,
      kind: 'query',
      subscriptionId: subId,
      content: imagenes[i % imagenes.length],
      contentType: 'image/jpeg'
    });
    await store.setPhotoFaceId(foto.id, `seed-face-q-${i}`);
    await store.clearPhotoContent(foto.id); // la foto del rescatista no se guarda
    registrar.foto(foto.id, fechas[i]);
    anclas.push({ ...person, faceId: `seed-face-q-${i}`, surface: esRescate ? 'rescate' : 'api' });
  }
  return anclas;
}

// Familiares que pidieron aviso. Solo las verificadas reciben correo, y el
// panel muestra las dos cifras — con todas verificadas el paréntesis no dice
// nada.
async function crearSuscripciones(store, personas, registrar) {
  let creadas = 0;
  for (let i = 0; i < FAMILIARES_SUSCRITOS; i++) {
    const persona = personas[i];
    if (i % 3 === 2) {
      const { sub } = await store.subscribe(persona.id, 'whatsapp', telefono(200 + i), {
        verified: i % 2 === 0
      });
      registrar.suscripcion(sub.id, persona.fecha);
    } else {
      const { sub } = await store.subscribe(persona.id, 'email', `familiar.prueba.${i}@ejemplo.com`);
      // El correo nace SIN verificar; se "verifica" la mayoría para que el
      // contraste sea legible sin ser irreal.
      if (i % 4 !== 3) await store.verifySubscription(sub.verify_token);
      registrar.suscripcion(sub.id, persona.fecha);
    }
    creadas++;
  }
  return { creadas };
}

// ---------------------------------------------------------------------------
// Las bitácoras (SQL directo: son las únicas tablas donde el seed necesita
// fijar `created_at`, y el store no lo expone porque en la app siempre es
// "ahora")
// ---------------------------------------------------------------------------

function sembrarCoincidencias(db, personas, anclas, azar) {
  const insertar = db.prepare(
    'INSERT INTO match_log (person_id, update_id, face_id, similarity, surface, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const conFoto = personas.filter((p) => p.faceId);
  let total = 0;

  for (const [, min, max, superficies] of COINCIDENCIAS) {
    for (const [surface, cuantos] of Object.entries(superficies)) {
      const fechas = repartirFechas(cuantos, azar);
      for (let i = 0; i < cuantos; i++) {
        const persona = conFoto[Math.floor(azar() * conFoto.length)];
        // 100% significa la MISMA firma facial: casi siempre la misma foto
        // subida dos veces. Se registra contra la firma de la propia persona,
        // que es exactamente lo que pasa en la realidad y por lo que el panel
        // lo señala como alarma de calidad y no como un logro.
        const ancla = anclas[Math.floor(azar() * anclas.length)];
        const faceId = min === 100 ? persona.faceId : ancla.faceId;
        const similarity = min === max ? 100 : Number((min + azar() * (max - min)).toFixed(4));
        insertar.run(persona.id, persona.updateId, faceId, similarity, surface, fechas[i]);
        total++;
      }
    }
  }
  return total;
}

function sembrarEnvios(db, personas, azar) {
  const insertar = db.prepare(
    'INSERT INTO contact_log (person_id, update_id, channel, result, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  let total = 0;
  for (const [channel, resultados] of Object.entries(ENVIOS)) {
    for (const [result, cuantos] of Object.entries(resultados)) {
      const fechas = repartirFechas(cuantos, azar);
      for (let i = 0; i < cuantos; i++) {
        const persona = personas[Math.floor(azar() * personas.length)];
        insertar.run(persona.id, persona.updateId, channel, result, fechas[i]);
        total++;
      }
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Orquestación
// ---------------------------------------------------------------------------

async function sembrar({ dbPath = env.DB_PATH, entorno = process.env, log = console.log } = {}) {
  const razones = razonesParaNegarse(entorno);
  if (razones.length) {
    const detalle = [...new Set(razones)].map((r) => `  · ${r}`).join('\n');
    throw new Error(
      'El seed se niega a correr: este entorno no es una base local de desarrollo.\n' +
        `${detalle}\n` +
        '  Escribe datos sintéticos. Contra una base con personas reales sería un accidente irreversible.'
    );
  }

  const azar = prng(20260810);

  // 1) Que exista el esquema. Lo crea el adaptador de siempre — el seed nunca
  //    escribe un CREATE TABLE propio, porque dos definiciones del mismo
  //    esquema se separan sin que nadie se dé cuenta.
  let adapter = await createSqliteAdapter(dbPath);
  await adapter.close();

  // 2) Borrar lo de la corrida anterior.
  let db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  const borradas = limpiar(db);
  db.close();

  // 3) Sembrar por la puerta de la app: findOrCreatePerson es quien fusiona
  //    los duplicados, y una siembra que se salte esa lógica no demuestra
  //    nada sobre ella.
  adapter = await createSqliteAdapter(dbPath);
  const store = createStore(adapter);
  const fechados = { people: [], updates: [], photos: [], subscriptions: [] };
  const registrar = {
    persona: (id, fecha) => fechados.people.push([fecha, id]),
    update: (id, fecha) => fechados.updates.push([fecha, id]),
    foto: (id, fecha) => fechados.photos.push([fecha, id]),
    suscripcion: (id, fecha) => fechados.subscriptions.push([fecha, id])
  };

  const imagenes = await generarImagenes();
  const personas = await crearPersonasBase(store, azar, registrar);
  const fusionadas = await crearFichasDuplicadas(store, personas, azar, registrar);
  const indexadas = await crearFotosDeReporte(store, personas, imagenes, registrar);
  const anclas = await crearConsultas(store, imagenes, azar, registrar);
  const suscripciones = await crearSuscripciones(store, personas, registrar);
  await store.close();

  // 4) Fechar hacia atrás y escribir las bitácoras. El store no deja fijar
  //    `created_at` (en la app siempre es "ahora"), y sin fechas repartidas la
  //    serie de 7 días es una sola barra.
  db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  const fechar = db.transaction(() => {
    for (const [tabla, filas] of Object.entries(fechados)) {
      const stmt = db.prepare(`UPDATE ${tabla} SET created_at = ? WHERE id = ?`);
      for (const [fecha, id] of filas) stmt.run(fecha, id);
    }
  });
  fechar();
  const coincidencias = db.transaction(() => sembrarCoincidencias(db, personas, anclas, azar));
  const envios = db.transaction(() => sembrarEnvios(db, personas, azar));
  const totalCoincidencias = coincidencias();
  const totalEnvios = envios();

  const contar = (sql) => db.prepare(sql).get().n;
  const resumen = {
    dbPath,
    borradas,
    personas: contar('SELECT COUNT(*) AS n FROM people'),
    personasReportadas: PERSONAS_BASE,
    anclas: anclas.length,
    fichas: contar('SELECT COUNT(*) AS n FROM updates'),
    fichasFusionadas: fusionadas,
    fotos: contar('SELECT COUNT(*) AS n FROM photos'),
    fotosIndexadas: contar('SELECT COUNT(*) AS n FROM photos WHERE face_id IS NOT NULL'),
    fotosDeReporteIndexadas: indexadas,
    // Del total: las de familiares (crearSuscripciones) más las que deja un
    // rescatista al preguntar (crearConsultas).
    suscripciones: contar('SELECT COUNT(*) AS n FROM subscriptions'),
    suscripcionesDeFamiliares: suscripciones.creadas,
    suscripcionesVerificadas: contar('SELECT COUNT(*) AS n FROM subscriptions WHERE verified = 1'),
    coincidencias: totalCoincidencias,
    envios: totalEnvios,
    aSalvo: contar(
      `WITH ultima AS (
         SELECT person_id, status, ROW_NUMBER() OVER (PARTITION BY person_id ORDER BY created_at DESC, id DESC) AS rn
         FROM updates
       )
       SELECT COUNT(*) AS n FROM ultima WHERE rn = 1 AND status = 'safe'`
    )
  };
  db.close();

  if (log) imprimirResumen(resumen, log);
  return resumen;
}

function imprimirResumen(r, log) {
  log('');
  log('  Base sembrada con datos SINTÉTICOS.');
  log(`  ${r.dbPath}`);
  if (r.borradas) log(`  (se borraron ${r.borradas} personas de una siembra anterior)`);
  log('');
  log(`  Personas en la base ............ ${r.personas}`);
  log(`    reportadas ................... ${r.personasReportadas}  (de ${r.personasReportadas + r.fichasFusionadas} fichas: ${r.fichasFusionadas} se fusionaron)`);
  log(`    anclas de consulta ........... ${r.anclas}  (rescatista y API — no son personas reportadas)`);
  log(`  Actualizaciones ............... ${r.fichas}`);
  log(`  Fotos (en el índice facial) ... ${r.fotos} (${r.fotosIndexadas})`);
  log(`  Suscripciones (verificadas) ... ${r.suscripciones} (${r.suscripcionesVerificadas})`);
  log(`  Coincidencias registradas ..... ${r.coincidencias}`);
  log(`  Envíos intentados ............. ${r.envios}`);
  log(`  Personas a salvo .............. ${r.aSalvo}`);
  log('');
  log('  Panel:  npm run dev  →  http://localhost:3000/admin/stats');
  log('  El embudo de ese panel recalcula contra Rekognition; sin credenciales de');
  log('  AWS dirá que no se pudo medir, que es lo correcto — no un cero.');
  log('');
}

module.exports = { sembrar, razonesParaNegarse };

if (require.main === module) {
  sembrar().catch((error) => {
    console.error(`\n  ${error.message}\n`);
    process.exit(1);
  });
}
