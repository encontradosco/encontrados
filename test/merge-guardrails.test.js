// #150: findOrCreatePerson fusionaba dos reportes por nombre solo (score >=
// 0.85), sin mirar nada más — y eso ya causó un incidente real en
// producción (dos ciudades a ~200 km fusionadas bajo una persona). Estas
// pruebas cubren evaluateMerge directamente contra un store real: el
// departamento como señal primaria, el rostro como desempate SOLO cuando el
// departamento no puede decidir, y que ninguna de las dos pueda tumbar un
// reporte.
//
// Orden de los nombres: matchScore NO es simétrico y searchPeople llama
// matchScore(nombreDeLaBúsqueda, nombreDelCandidatoYaGuardado) — confirmado
// con matchScore(normalize('Johan Gómez'), normalize('John Alex Gomez')) ===
// 0.855 (el ejemplo real del propio issue #150), pero en el orden inverso da
// 0. Por eso acá SIEMPRE se crea primero a la persona con el nombre largo
// ("John Alex Gomez") y la fusión se evalúa buscando con el nombre corto
// ("Johan Gómez") — es el único orden en el que ese 0.855 del issue ocurre.
const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createStore } = require('../src/people');

async function freshStore() {
  return createStore(await createSqliteAdapter(':memory:'));
}

// Firmas idénticas por bytes idénticos: dos fotos con el mismo `label`
// comparten faceId (misma "cara"), dos labels distintos no.
function fakeMatcher() {
  const faceIdByContent = new Map();
  let next = 1;
  const key = (bytes) => Buffer.from(bytes).toString('utf8');
  return {
    enabled: true,
    async indexFace(bytes) {
      const k = key(bytes);
      let faceId = faceIdByContent.get(k);
      if (!faceId) {
        faceId = `face-${next++}`;
        faceIdByContent.set(k, faceId);
      }
      return { faceId, geometry: null };
    },
    async detectFace() {
      return null;
    },
    async searchByImage(bytes) {
      const faceId = faceIdByContent.get(key(bytes));
      return faceId ? [{ faceId, similarity: 97 }] : [];
    }
  };
}

async function photoBytes(label) {
  let h = 0;
  for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) % 16777216;
  return sharp({
    create: { width: 120, height: 150, channels: 3, background: { r: (h >> 16) & 255, g: (h >> 8) & 255, b: h & 255 } }
  })
    .jpeg()
    .toBuffer();
}

// Indexa una foto de reporte para `personId` y la deja como su firma facial
// — lo mínimo que evaluateMerge necesita ver para tener "algo" con qué
// comparar (faceIdsForPerson).
async function indexReportPhoto(store, matcher, personId, label) {
  const bytes = await photoBytes(label);
  const { faceId } = await matcher.indexFace(bytes);
  const photo = await store.addPhoto({ personId, kind: 'report', content: bytes, contentType: 'image/jpeg' });
  await store.setPhotoFaceId(photo.id, faceId);
  return bytes;
}

test('nombre exacto (reporte repetido) no evalúa nada — mergeCheck es null', async () => {
  const store = await freshStore();
  const { person: p1 } = await store.findOrCreatePerson('Johan Gómez');
  const { person: p2, created, mergeCheck } = await store.findOrCreatePerson('Johan Gómez', {
    department: 'Valle del Cauca'
  });
  assert.equal(p2.id, p1.id);
  assert.equal(created, false);
  assert.equal(mergeCheck, null, 'un nombre normalizado idéntico no pasa por el desempate');
});

test('nombre >= 0.85 y ningún departamento en ninguno de los dos lados: se fusiona, como siempre (sin señal que comparar)', async () => {
  const store = await freshStore();
  const { person: p1 } = await store.findOrCreatePerson('John Alex Gomez');
  await store.addUpdate(p1.id, { status: 'missing', source: 'web' });

  const { person: p2, created, mergeCheck } = await store.findOrCreatePerson('Johan Gómez');
  assert.equal(created, false);
  assert.equal(p2.id, p1.id);
  assert.equal(mergeCheck.score >= 0.85, true);
  assert.equal(mergeCheck.departmentMatch, 'unknown');
  assert.equal(mergeCheck.faceMatch, 'unknown');
  assert.equal(mergeCheck.blocked, false);
  assert.equal(mergeCheck.personId, p1.id);
});

test('nombre >= 0.85, mismo departamento: se fusiona, y department_match queda "match"', async () => {
  const store = await freshStore();
  const { person: p1 } = await store.findOrCreatePerson('John Alex Gomez');
  await store.addUpdate(p1.id, { status: 'missing', department: 'Chocó', source: 'web' });

  const { person: p2, created, mergeCheck } = await store.findOrCreatePerson('Johan Gómez', {
    department: 'Chocó'
  });
  assert.equal(created, false);
  assert.equal(p2.id, p1.id);
  assert.equal(mergeCheck.departmentMatch, 'match');
  assert.equal(mergeCheck.blocked, false);
});

// Señalado en revisión del PR: mirar solo el update MÁS RECIENTE se queda
// ciego si ESE update en particular no repite el departamento — por ejemplo
// un update de solo-estado que llega después del reporte original.
// latestDepartmentForPerson busca hacia atrás en TODOS los updates.
test('un update posterior sin departamento no tapa el departamento de un update anterior', async () => {
  const store = await freshStore();
  const { person: p1 } = await store.findOrCreatePerson('John Alex Gomez');
  await store.addUpdate(p1.id, { status: 'missing', department: 'Chocó', source: 'web' });
  // Un segundo update sobre la MISMA persona, sin departamento — por ejemplo
  // una confirmación de estado que no repitió el dato.
  await store.addUpdate(p1.id, { status: 'missing', message: 'Sigue sin aparecer', source: 'web' });

  const { person: p2, mergeCheck } = await store.findOrCreatePerson('Johan Gómez', { department: 'Chocó' });
  assert.equal(p2.id, p1.id);
  assert.equal(
    mergeCheck.departmentMatch,
    'match',
    'el departamento del primer update sigue siendo la señal, aunque el más reciente no lo repita'
  );
  assert.equal(mergeCheck.blocked, false);
});

// El caso real del issue: dos ciudades a ~200 km, fusionadas por nombre solo.
test('nombre >= 0.85 pero departamentos DISTINTOS: NO se fusiona — se crea una persona aparte', async () => {
  const store = await freshStore();
  const { person: p1 } = await store.findOrCreatePerson('John Alex Gomez');
  await store.addUpdate(p1.id, { status: 'missing', department: 'Chocó', source: 'web' });

  const { person: p2, created, mergeCheck } = await store.findOrCreatePerson('Johan Gómez', {
    department: 'Valle del Cauca'
  });
  assert.equal(created, true, 'un departamento distinto bloquea la fusión automática');
  assert.notEqual(p2.id, p1.id);
  assert.equal(mergeCheck.departmentMatch, 'mismatch');
  assert.equal(mergeCheck.blocked, true);
  assert.equal(mergeCheck.personId, p1.id, 'mergeCheck.personId es el CANDIDATO evaluado, no la ficha nueva');
});

test('departamento desconocido en algún lado, pero el rostro SÍ coincide: se fusiona (desempate a favor)', async () => {
  const store = await freshStore();
  const matcher = fakeMatcher();
  const { person: p1 } = await store.findOrCreatePerson('John Alex Gomez');
  await store.addUpdate(p1.id, { status: 'missing', source: 'web' }); // sin departamento
  await indexReportPhoto(store, matcher, p1.id, 'misma-cara');

  const nuevaFoto = await photoBytes('misma-cara'); // mismos bytes = misma "cara"
  const { person: p2, created, mergeCheck } = await store.findOrCreatePerson('Johan Gómez', {
    matcher,
    photoBytes: nuevaFoto
  });
  assert.equal(created, false);
  assert.equal(p2.id, p1.id);
  assert.equal(mergeCheck.departmentMatch, 'unknown');
  assert.equal(mergeCheck.faceMatch, 'match');
  assert.equal(mergeCheck.blocked, false);
});

test('departamento desconocido en algún lado, y el rostro NO coincide: NO se fusiona', async () => {
  const store = await freshStore();
  const matcher = fakeMatcher();
  const { person: p1 } = await store.findOrCreatePerson('John Alex Gomez');
  await store.addUpdate(p1.id, { status: 'missing', source: 'web' });
  await indexReportPhoto(store, matcher, p1.id, 'cara-uno');

  const nuevaFoto = await photoBytes('cara-dos'); // bytes distintos = "cara" distinta
  const { person: p2, created, mergeCheck } = await store.findOrCreatePerson('Johan Gómez', {
    matcher,
    photoBytes: nuevaFoto
  });
  assert.equal(created, true);
  assert.notEqual(p2.id, p1.id);
  assert.equal(mergeCheck.faceMatch, 'mismatch');
  assert.equal(mergeCheck.blocked, true);
});

test('departamento desconocido, candidato SIN foto indexada: no hay nada que comparar — se fusiona igual que antes', async () => {
  const store = await freshStore();
  const matcher = fakeMatcher();
  const { person: p1 } = await store.findOrCreatePerson('John Alex Gomez');
  await store.addUpdate(p1.id, { status: 'missing', source: 'web' }); // sin foto indexada

  const { person: p2, created, mergeCheck } = await store.findOrCreatePerson('Johan Gómez', {
    matcher,
    photoBytes: await photoBytes('lo-que-sea')
  });
  assert.equal(created, false);
  assert.equal(p2.id, p1.id);
  assert.equal(mergeCheck.faceMatch, 'unknown');
  assert.equal(mergeCheck.blocked, false);
});

test('departamento desconocido, reporte nuevo SIN foto: no hay nada que comparar — se fusiona igual que antes', async () => {
  const store = await freshStore();
  const matcher = fakeMatcher();
  const { person: p1 } = await store.findOrCreatePerson('John Alex Gomez');
  await store.addUpdate(p1.id, { status: 'missing', source: 'web' });
  await indexReportPhoto(store, matcher, p1.id, 'cara-uno');

  const { person: p2, created, mergeCheck } = await store.findOrCreatePerson('Johan Gómez', { matcher });
  assert.equal(created, false);
  assert.equal(p2.id, p1.id);
  assert.equal(mergeCheck.faceMatch, 'unknown');
  assert.equal(mergeCheck.blocked, false);
});

// La regla de oro de este servicio, aplicada acá: Rekognition caído no puede
// bloquear un reporte. Degradar a "sin señal" es lo que YA hacía la app
// antes de #150 — este PR no puede volver el sistema MÁS frágil que antes.
test('Rekognition caído durante el desempate no bloquea el reporte — degrada a "sin señal"', async () => {
  const store = await freshStore();
  const matcher = fakeMatcher();
  const { person: p1 } = await store.findOrCreatePerson('John Alex Gomez');
  await store.addUpdate(p1.id, { status: 'missing', source: 'web' });
  await indexReportPhoto(store, matcher, p1.id, 'cara-uno');

  const brokenMatcher = {
    enabled: true,
    async searchByImage() {
      throw new Error('Rekognition caído, a propósito');
    }
  };
  const { person: p2, created, mergeCheck } = await store.findOrCreatePerson('Johan Gómez', {
    matcher: brokenMatcher,
    photoBytes: await photoBytes('cara-dos')
  });
  assert.equal(created, false, 'un Rekognition caído nunca puede bloquear una fusión que antes procedía');
  assert.equal(mergeCheck.faceMatch, 'unknown');
  assert.equal(mergeCheck.blocked, false);
});

// Subir el umbral NO es el arreglo (razonamiento explícito del issue): un
// nombre por DEBAJO de 0.85 sigue sin fusionar solo, con o sin #150.
test('un nombre por debajo del umbral de todos modos crea una persona aparte, sin evaluar nada', async () => {
  const store = await freshStore();
  const { person: p1 } = await store.findOrCreatePerson('John Alex Gomez');
  await store.addUpdate(p1.id, { status: 'missing', department: 'Chocó', source: 'web' });

  const { person: p2, created, mergeCheck } = await store.findOrCreatePerson('Alguien Completamente Distinto', {
    department: 'Chocó'
  });
  assert.equal(created, true);
  assert.notEqual(p2.id, p1.id);
  assert.equal(mergeCheck, null, 'por debajo de 0.85 nunca llega a evaluarse — sigue siendo un nombre nuevo');
});
