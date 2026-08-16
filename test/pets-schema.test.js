const test = require('node:test');
const assert = require('node:assert');
const { createSqliteAdapter } = require('../src/store/sqlite');

async function freshAdapter() {
  return createSqliteAdapter(':memory:');
}

test('insertPet guarda y getPet lee de vuelta', async () => {
  const adapter = await freshAdapter();
  const pet = await adapter.insertPet({
    species: 'dog',
    petName: 'Toby',
    description: 'Mediano, negro, collar rojo',
    contact: '300 111 2222'
  });
  assert.equal(pet.species, 'dog');
  assert.equal(pet.pet_name, 'Toby');
  const back = await adapter.getPet(pet.id);
  assert.equal(back.contact, '300 111 2222');
  assert.equal(back.resolved_at, null);
});

test('markPetResolved pone resolved_at', async () => {
  const adapter = await freshAdapter();
  const pet = await adapter.insertPet({ species: 'cat', description: null, contact: 'a@ejemplo.com' });
  const resolved = await adapter.markPetResolved(pet.id);
  assert.ok(resolved.resolved_at, 'debe quedar una fecha');
});

test('una foto report necesita pet_id; una query no', async () => {
  const adapter = await freshAdapter();
  const pet = await adapter.insertPet({ species: 'dog', description: null, contact: '300 000 0000' });
  const report = await adapter.insertPetPhoto({
    petId: pet.id,
    kind: 'report',
    species: 'dog',
    content: Buffer.from('foto'),
    contentType: 'image/jpeg'
  });
  assert.equal(report.pet_id, pet.id);

  const query = await adapter.insertPetPhoto({
    petId: null,
    kind: 'query',
    species: 'dog',
    content: Buffer.from('foto2'),
    contentType: 'image/jpeg'
  });
  assert.equal(query.pet_id, null);

  // Una fila 'report' sin pet_id la rechaza el CHECK del esquema.
  await assert.rejects(() =>
    adapter.insertPetPhoto({ petId: null, kind: 'report', species: 'dog', content: Buffer.from('x'), contentType: 'image/jpeg' })
  );
});

test('setPetPhotoEmbedding + petPhotosForMatching filtran por kind y especie', async () => {
  const adapter = await freshAdapter();
  const pet = await adapter.insertPet({ species: 'dog', description: null, contact: '300 000 0000' });
  const report = await adapter.insertPetPhoto({
    petId: pet.id, kind: 'report', species: 'dog', content: Buffer.from('f'), contentType: 'image/jpeg'
  });
  await adapter.setPetPhotoEmbedding(report.id, [0.1, 0.2, 0.3], 'modelo-test');

  const gatoReport = await adapter.insertPet({ species: 'cat', description: null, contact: 'x@ejemplo.com' });
  const gatoPhoto = await adapter.insertPetPhoto({
    petId: gatoReport.id, kind: 'report', species: 'cat', content: Buffer.from('g'), contentType: 'image/jpeg'
  });
  await adapter.setPetPhotoEmbedding(gatoPhoto.id, [0.9, 0.9, 0.9], 'modelo-test');

  const dogs = await adapter.petPhotosForMatching('report', 'dog');
  assert.equal(dogs.length, 1);
  assert.equal(dogs[0].pet_id, pet.id);

  const cats = await adapter.petPhotosForMatching('report', 'cat');
  assert.equal(cats.length, 1);

  // Sin embedding todavía: no debe aparecer como candidata.
  const sinEmbedding = await adapter.insertPetPhoto({
    petId: pet.id, kind: 'report', species: 'dog', content: Buffer.from('h'), contentType: 'image/jpeg'
  });
  const stillOne = await adapter.petPhotosForMatching('report', 'dog');
  assert.equal(stillOne.length, 1, 'la foto sin embedding no debe salir como candidata');
  assert.equal((await adapter.petPhotosMissingEmbedding(50)).some((p) => p.id === sinEmbedding.id), true);
});

test('petPhotosMissingEmbedding no incluye una foto "encontré" cuyo contenido ya se borró', async () => {
  const adapter = await freshAdapter();
  // Una foto 'query' cuyo contenido ya se limpió (procesada mientras el
  // matcher estaba caído, y nadie corrió el backfill desde entonces) no
  // tiene forma de conseguir jamás un embedding — sin el filtro de contenido
  // no vacío, se quedaría "pendiente" para siempre y ahogaría la red de
  // seguridad con filas que ya no se pueden comparar.
  const cleared = await adapter.insertPetPhoto({
    petId: null, kind: 'query', species: 'dog', content: Buffer.from('foto'), contentType: 'image/jpeg'
  });
  await adapter.clearPetPhotoContent(cleared.id);

  const pending = await adapter.insertPetPhoto({
    petId: null, kind: 'query', species: 'dog', content: Buffer.from('foto viva'), contentType: 'image/jpeg'
  });

  const missing = await adapter.petPhotosMissingEmbedding(50);
  assert.equal(missing.some((p) => p.id === cleared.id), false, 'una foto ya vaciada no debe volver a "pendiente"');
  assert.equal(missing.some((p) => p.id === pending.id), true, 'una foto con contenido sí debe seguir pendiente');
});

test('petPhotosForMatching excluye las fotos de una mascota ya marcada como resuelta', async () => {
  const adapter = await freshAdapter();
  const pet = await adapter.insertPet({ species: 'dog', description: null, contact: '300 000 0000' });
  const report = await adapter.insertPetPhoto({
    petId: pet.id, kind: 'report', species: 'dog', content: Buffer.from('f'), contentType: 'image/jpeg'
  });
  await adapter.setPetPhotoEmbedding(report.id, [0.1, 0.2, 0.3], 'modelo-test');

  let candidates = await adapter.petPhotosForMatching('report', 'dog');
  assert.equal(candidates.length, 1, 'antes de resolverse, sí debe salir como candidata');

  await adapter.markPetResolved(pet.id);

  candidates = await adapter.petPhotosForMatching('report', 'dog');
  assert.equal(candidates.length, 0, 'una mascota ya resuelta no debe salir como candidata de coincidencia');
});

test('petPhotosForMatching no excluye fotos "encontré" (que no tienen pet_id) por el filtro de resuelta', async () => {
  const adapter = await freshAdapter();
  const query = await adapter.insertPetPhoto({
    petId: null, kind: 'query', species: 'dog', content: Buffer.from('f'), contentType: 'image/jpeg'
  });
  await adapter.setPetPhotoEmbedding(query.id, [0.1, 0.2, 0.3], 'modelo-test');

  const candidates = await adapter.petPhotosForMatching('query', 'dog');
  assert.equal(candidates.length, 1, 'una foto "encontré" sin mascota asociada no debe caer en el filtro de resuelta');
});

test('clearPetPhotoContent vacía el contenido sin borrar la fila', async () => {
  const adapter = await freshAdapter();
  const photo = await adapter.insertPetPhoto({
    petId: null, kind: 'query', species: 'cat', content: Buffer.from('foto'), contentType: 'image/jpeg'
  });
  await adapter.clearPetPhotoContent(photo.id);
  const back = await adapter.getPetPhoto(photo.id);
  assert.equal(back.content.length, 0);
});

test('setPetPhotoThumbnail y petPhotosForPet', async () => {
  const adapter = await freshAdapter();
  const pet = await adapter.insertPet({ species: 'dog', description: null, contact: '300 000 0000' });
  const photo = await adapter.insertPetPhoto({
    petId: pet.id, kind: 'report', species: 'dog', content: Buffer.from('foto'), contentType: 'image/jpeg'
  });
  await adapter.setPetPhotoThumbnail(photo.id, { small: Buffer.from('mini'), contentType: 'image/jpeg' });
  const forPet = await adapter.petPhotosForPet(pet.id);
  assert.equal(forPet.length, 1);
  assert.equal(forPet[0].thumb_type, 'image/jpeg');
});

const { createPetStore } = require('../src/pets');

test('createPetStore.petPhotosForMatching devuelve el embedding ya parseado', async () => {
  const adapter = await freshAdapter();
  const petStore = createPetStore(adapter);
  const pet = await petStore.addPet({ species: 'dog', petName: null, description: null, contact: '300 000 0000' });
  const photo = await petStore.addPetPhoto({
    petId: pet.id, kind: 'report', species: 'dog', content: Buffer.from('f'), contentType: 'image/jpeg'
  });
  await petStore.setPetPhotoEmbedding(photo.id, [0.5, 0.25, 0.1], 'modelo-test');

  const candidates = await petStore.petPhotosForMatching('report', 'dog');
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].embedding, [0.5, 0.25, 0.1]);
  assert.equal(typeof candidates[0].embedding[0], 'number');
});
