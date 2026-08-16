// Capa de dominio para mascotas perdidas — espejo liviano de src/people.js,
// pero sin nada de lo que ese archivo necesita para PERSONAS (búsqueda por
// nombre, fonética, ancla de rescate). Una mascota no tiene nombre que buscar
// ni un timeline de estados: un reporte es un hecho, no una serie.
//
// El embedding vuelve de la base como TEXTO en SQLite y ya parseado en
// Postgres (columna JSONB) — la misma diferencia que ya resuelve
// withParsedDetail() en people.js para face_detail. Se normaliza aquí, una
// sola vez, para que nadie que compare dos embeddings tenga que acordarse de
// cuál motor está corriendo.
function parseEmbeddingRow(row) {
  if (row.embedding == null) return row;
  const embedding = typeof row.embedding === 'string' ? JSON.parse(row.embedding) : row.embedding;
  return { ...row, embedding };
}

// Postgres devuelve created_at/resolved_at (TIMESTAMPTZ) ya como Date; SQLite
// los devuelve como el texto ISO que escribió el propio adaptador. Mismo
// problema que ya resuelve isoRow() en people.js, misma solución — sin esto,
// <time datetime="..."> se llena con el toString() de un Date en vez de un
// ISO real en producción (Postgres), y nunca se ve en dev (SQLite).
function isoRow(row) {
  if (!row) return row;
  const out = { ...row };
  for (const field of ['created_at', 'resolved_at']) {
    if (out[field] instanceof Date) out[field] = out[field].toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  return out;
}

function createPetStore(adapter) {
  return {
    async addPet({ species, petName, description, contact }) {
      return isoRow(await adapter.insertPet({ species, petName, description, contact }));
    },
    async getPet(id) {
      return isoRow(await adapter.getPet(id));
    },
    async markPetResolved(id) {
      return isoRow(await adapter.markPetResolved(id));
    },
    async addPetPhoto(fields) {
      return adapter.insertPetPhoto(fields);
    },
    async getPetPhoto(id) {
      const row = await adapter.getPetPhoto(id);
      return row ? parseEmbeddingRow(row) : row;
    },
    async setPetPhotoEmbedding(photoId, embedding, model) {
      return adapter.setPetPhotoEmbedding(photoId, embedding, model);
    },
    async setPetPhotoThumbnail(photoId, thumb) {
      return adapter.setPetPhotoThumbnail(photoId, thumb);
    },
    async clearPetPhotoContent(photoId) {
      return adapter.clearPetPhotoContent(photoId);
    },
    async petPhotosForMatching(kind, species) {
      const rows = await adapter.petPhotosForMatching(kind, species);
      return rows.map(parseEmbeddingRow);
    },
    async petPhotosMissingEmbedding(limit) {
      return adapter.petPhotosMissingEmbedding(limit);
    },
    async petPhotosForPet(petId) {
      return adapter.petPhotosForPet(petId);
    },
    async lostPets(limit = 50) {
      return (await adapter.lostPets(limit)).map(isoRow);
    },
    async reunitedPetsCount() {
      return adapter.reunitedPetsCount();
    },
    // Una foto por mascota, para el listado — espejo de reportPhotoByPerson
    // en people.js: el adaptador ya ordena por (pet_id, sin-thumb, id), así
    // que la primera fila de cada mascota es la que gana.
    async petPhotosForPets(petIds) {
      const rows = await adapter.petPhotosForPets(petIds);
      const byPet = new Map();
      for (const row of rows) {
        if (!byPet.has(row.pet_id)) byPet.set(row.pet_id, row);
      }
      return byPet;
    }
  };
}

module.exports = { createPetStore };
