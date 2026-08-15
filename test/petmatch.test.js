const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createPetStore } = require('../src/pets');

// Vectores ya normalizados a propósito: la similitud coseno entre dos
// vectores idénticos es 1 (100%), y entre estos dos "distintos" cae bajo
// cualquier umbral razonable — no hace falta un modelo real para probar la
// lógica de comparación.
const VECTOR_A = [1, 0, 0];
const VECTOR_B = [0, 1, 0];

// Fotos reales, chiquitas, para que `toMatchable` (dentro de processPetPhoto)
// las acepte de verdad: un Buffer.from('texto') no es una imagen, sharp no lo
// puede decodificar, y la foto queda marcada `unreadable` sin llegar nunca a
// compararse. Mismo patrón que ya usa test/rescue.test.js — un JPEG real de
// color plano, determinístico a partir de la etiqueta, cacheado. 100x100
// alcanza acá: a diferencia de las pruebas de personas, mascotas no necesita
// geometría de recorte de cara.
const jpegCache = new Map();
async function photoBytes(label) {
  if (!jpegCache.has(label)) {
    let h = 0;
    for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) % 16777216;
    jpegCache.set(
      label,
      await sharp({
        create: {
          width: 100,
          height: 100,
          channels: 3,
          background: { r: (h >> 16) & 255, g: (h >> 8) & 255, b: h & 255 }
        }
      })
        .jpeg()
        .toBuffer()
    );
  }
  return jpegCache.get(label);
}

// El matcher de mentira sigue leyendo la clave con bytes.toString('utf8') —
// eso no cambia. Lo que cambia es CON QUÉ se construye el diccionario en cada
// prueba: ya no es el literal 'toby', sino la representación utf8 de los
// bytes reales que da `photoBytes('toby')`. Esos bytes le llegan intactos a
// embed() porque toMatchable no los toca cuando ya son un JPEG chico y
// derecho (ver el "fast path" en src/photo.js), así que la clave calza.
function fakePetMatcherFor(vectors) {
  let calls = 0;
  return {
    enabled: true,
    status: 'fake',
    async embed(bytes) {
      calls++;
      const key = bytes.toString('utf8');
      return vectors[key] ? { embedding: vectors[key], model: 'fake-model' } : null;
    },
    get calls() {
      return calls;
    }
  };
}

async function setup() {
  const adapter = await createSqliteAdapter(':memory:');
  const petStore = createPetStore(adapter);
  return { petStore };
}

test('una foto de reporte sin coincidencias previas se guarda y no arma ningún match', async () => {
  const { petStore } = await setup();
  const { processPetPhoto } = require('../src/petmatch');
  const toby = await photoBytes('toby');
  const matcher = fakePetMatcherFor({ [toby.toString('utf8')]: VECTOR_A });

  const pet = await petStore.addPet({ species: 'dog', petName: 'Toby', description: null, contact: '300 111 2222' });
  const { photo, matches } = await processPetPhoto(petStore, matcher, {
    petId: pet.id,
    kind: 'report',
    species: 'dog',
    bytes: toby,
    contentType: 'image/jpeg'
  });

  assert.equal(matches.length, 0);
  const stored = await petStore.getPetPhoto(photo.id);
  assert.deepEqual(stored.embedding, VECTOR_A);
  assert.ok(stored.content.length > 0, 'una foto de REPORTE sí conserva sus bytes');
});

test('una foto "encontré" que coincide con un reporte muestra el contacto de quien lo puso, y no guarda sus bytes', async () => {
  const { petStore } = await setup();
  const { processPetPhoto } = require('../src/petmatch');
  const toby = await photoBytes('toby');
  const encontrado = await photoBytes('encontrado');
  const matcher = fakePetMatcherFor({
    [toby.toString('utf8')]: VECTOR_A,
    [encontrado.toString('utf8')]: VECTOR_A
  });

  const pet = await petStore.addPet({ species: 'dog', petName: 'Toby', description: null, contact: '300 111 2222' });
  await processPetPhoto(petStore, matcher, {
    petId: pet.id, kind: 'report', species: 'dog', bytes: toby, contentType: 'image/jpeg'
  });

  const { photo, matches } = await processPetPhoto(petStore, matcher, {
    kind: 'query', species: 'dog', bytes: encontrado, contentType: 'image/jpeg'
  });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].pet_id, pet.id);
  assert.ok(matches[0].similarity > 90);

  const stored = await petStore.getPetPhoto(photo.id);
  assert.equal(stored.content.length, 0, 'la foto de quien encontró a la mascota nunca se conserva');
});

test('no cruza especies: un perro parecido no aparece al buscar un gato', async () => {
  const { petStore } = await setup();
  const { processPetPhoto } = require('../src/petmatch');
  const perro = await photoBytes('perro');
  const buscando = await photoBytes('buscando');
  const matcher = fakePetMatcherFor({
    [perro.toString('utf8')]: VECTOR_A,
    [buscando.toString('utf8')]: VECTOR_A
  });

  const pet = await petStore.addPet({ species: 'dog', petName: null, description: null, contact: '300 111 2222' });
  await processPetPhoto(petStore, matcher, {
    petId: pet.id, kind: 'report', species: 'dog', bytes: perro, contentType: 'image/jpeg'
  });

  const { matches } = await processPetPhoto(petStore, matcher, {
    kind: 'query', species: 'cat', bytes: buscando, contentType: 'image/jpeg'
  });
  assert.equal(matches.length, 0, 'especies distintas nunca deben coincidir');
});

test('sin PET_MATCH_API_URL (matcher deshabilitado), la foto se guarda igual y sin comparar', async () => {
  const { petStore } = await setup();
  const { processPetPhoto } = require('../src/petmatch');
  const { createPetMatcher } = require('../src/petfaces');
  delete process.env.PET_MATCH_API_URL;
  const matcher = createPetMatcher();

  const pet = await petStore.addPet({ species: 'dog', petName: null, description: null, contact: '300 111 2222' });
  const perro = await photoBytes('perro');
  const { photo, matches } = await processPetPhoto(petStore, matcher, {
    petId: pet.id, kind: 'report', species: 'dog', bytes: perro, contentType: 'image/jpeg'
  });
  assert.equal(matches.length, 0);
  const stored = await petStore.getPetPhoto(photo.id);
  assert.equal(stored.embedding, null, 'sin servicio, no hay embedding que guardar');
  assert.ok(stored.content.length > 0, 'la foto se guarda de todos modos');
});

test('backfillUnindexedPetPhotos recoge lo que quedó sin embedding y lo compara', async () => {
  const { petStore } = await setup();
  const { processPetPhoto, backfillUnindexedPetPhotos } = require('../src/petmatch');
  delete process.env.PET_MATCH_API_URL;
  const { createPetMatcher } = require('../src/petfaces');
  const offlineMatcher = createPetMatcher();

  const pet = await petStore.addPet({ species: 'dog', petName: null, description: null, contact: '300 111 2222' });
  const perro = await photoBytes('perro');
  await processPetPhoto(petStore, offlineMatcher, {
    petId: pet.id, kind: 'report', species: 'dog', bytes: perro, contentType: 'image/jpeg'
  });

  const onlineMatcher = fakePetMatcherFor({ [perro.toString('utf8')]: VECTOR_A });
  const result = await backfillUnindexedPetPhotos(petStore, onlineMatcher, 100);
  assert.equal(result.processed, 1);

  const stored = (await petStore.petPhotosForMatching('report', 'dog'))[0];
  assert.deepEqual(stored.embedding, VECTOR_A);
});

test('un error de base al comparar no revienta processPetPhoto ni deja sin borrar los bytes de una foto "encontré"', async () => {
  const { petStore } = await setup();
  // Envoltura de mentira: todo lo demás pasa por el petStore real, pero
  // petPhotosForMatching (la lectura que matchPetPhoto hace para comparar)
  // revienta — como lo haría un error transitorio de base en un despliegue
  // serverless. embed() ya tuvo éxito para cuando esto pasa; lo que se prueba
  // es que ese fallo, DESPUÉS de embed(), no se escapa de processPetPhoto ni
  // le impide borrar los bytes de una foto 'query' (garantía de privacidad,
  // no cosmética).
  const flakyStore = {
    ...petStore,
    async petPhotosForMatching() {
      throw new Error('conexión a la base perdida (de mentira, para la prueba)');
    }
  };
  const { processPetPhoto } = require('../src/petmatch');
  const buscando = await photoBytes('buscando');
  const matcher = fakePetMatcherFor({ [buscando.toString('utf8')]: VECTOR_A });

  const { photo, matches } = await processPetPhoto(flakyStore, matcher, {
    kind: 'query',
    species: 'dog',
    bytes: buscando,
    contentType: 'image/jpeg'
  });

  assert.deepEqual(matches, [], 'un fallo al comparar se degrada a "sin coincidencias", no revienta');

  const stored = await petStore.getPetPhoto(photo.id);
  assert.equal(
    stored.content.length,
    0,
    'los bytes de una foto "encontré" se borran igual, aunque falle la comparación'
  );
});

test('con matcher deshabilitado, una foto "encontré" borra sus bytes aunque no se haya comparado', async () => {
  const { petStore } = await setup();
  const { processPetPhoto } = require('../src/petmatch');
  const { createPetMatcher } = require('../src/petfaces');
  delete process.env.PET_MATCH_API_URL;
  const matcher = createPetMatcher();

  const encontrado = await photoBytes('encontrado');
  const { photo } = await processPetPhoto(petStore, matcher, {
    kind: 'query',
    species: 'dog',
    bytes: encontrado,
    contentType: 'image/jpeg'
  });

  const stored = await petStore.getPetPhoto(photo.id);
  assert.equal(
    stored.content.length,
    0,
    'una foto "encontré" borra sus bytes incluso cuando el matcher está deshabilitado'
  );
});

test('cuando embed() devuelve null para una foto "encontré", se borran sus bytes igual', async () => {
  const { petStore } = await setup();
  const { processPetPhoto } = require('../src/petmatch');
  const encontrado = await photoBytes('encontrado');

  // Un matcher que devuelve null (falla) para cualquier foto
  const failingMatcher = {
    enabled: true,
    status: 'fake',
    async embed(bytes) {
      return null;
    }
  };

  const { photo } = await processPetPhoto(petStore, failingMatcher, {
    kind: 'query',
    species: 'dog',
    bytes: encontrado,
    contentType: 'image/jpeg'
  });

  const stored = await petStore.getPetPhoto(photo.id);
  assert.equal(
    stored.content.length,
    0,
    'una foto "encontré" borra sus bytes cuando embed() falla (devuelve null)'
  );
});

test('backfillUnindexedPetPhotos borra bytes de una foto "encontré" después de procesarla', async () => {
  const { petStore } = await setup();
  const { processPetPhoto, backfillUnindexedPetPhotos } = require('../src/petmatch');
  const { createPetMatcher } = require('../src/petfaces');

  // Primero, guardar una foto "encontré" con matcher deshabilitado
  delete process.env.PET_MATCH_API_URL;
  const offlineMatcher = createPetMatcher();

  const encontrado = await photoBytes('encontrado');
  const { photo: pendingPhoto } = await processPetPhoto(petStore, offlineMatcher, {
    kind: 'query',
    species: 'dog',
    bytes: encontrado,
    contentType: 'image/jpeg'
  });

  // Verificar que los bytes están presente (porque el matcher estaba deshabilitado al procesarla inicialmente)
  let stored = await petStore.getPetPhoto(pendingPhoto.id);
  // Nota: la foto se borra incluso con matcher deshabilitado (eso es lo que el test anterior verifica),
  // así que aquí crearemos la foto sin usar processPetPhoto
  const { petStore: petStore2 } = await setup();
  const fotoSinProcesar = await petStore2.addPetPhoto({
    kind: 'query',
    species: 'dog',
    content: encontrado,
    contentType: 'image/jpeg'
  });

  // Ahora ejecutar backfill con un matcher que funciona
  const workingMatcher = fakePetMatcherFor({ [encontrado.toString('utf8')]: VECTOR_A });
  const result = await backfillUnindexedPetPhotos(petStore2, workingMatcher, 100);

  assert.equal(result.processed, 1, 'backfill procesó 1 foto');

  // Verificar que el embedding se guardó Y los bytes se borraron
  stored = await petStore2.getPetPhoto(fotoSinProcesar.id);
  assert.deepEqual(stored.embedding, VECTOR_A, 'el embedding se guardó correctamente');
  assert.equal(
    stored.content.length,
    0,
    'los bytes de una foto "encontré" se borran después de backfill'
  );
});
