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

function createPetStore(adapter) {
  return {
    async addPet({ species, petName, description, contact }) {
      return adapter.insertPet({ species, petName, description, contact });
    },
    async getPet(id) {
      return adapter.getPet(id);
    },
    async markPetResolved(id) {
      return adapter.markPetResolved(id);
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
    }
  };
}

module.exports = { createPetStore };
