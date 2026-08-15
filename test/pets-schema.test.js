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
