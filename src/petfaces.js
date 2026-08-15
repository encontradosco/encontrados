// Proveedor de embeddings de mascotas. Producción: el servicio propio en
// pet-matcher/ (ver ese folder). Sin PET_MATCH_API_URL, el matching de
// mascotas queda apagado — mismo contrato de degradación que src/faces.js
// tiene para Rekognition: nunca lanza, nunca tumba un reporte.
function createPetMatcher(timeoutMs = 15000) {
  const apiUrl = process.env.PET_MATCH_API_URL;
  if (!apiUrl) {
    return {
      enabled: false,
      status: 'deshabilitado (sin PET_MATCH_API_URL)',
      async embed() {
        return null;
      }
    };
  }
  return {
    enabled: true,
    status: `activo (${apiUrl})`,
    async embed(bytes, contentType) {
      try {
        const form = new FormData();
        form.append('image', new Blob([bytes], { type: contentType || 'image/jpeg' }), 'foto.jpg');
        const res = await fetch(`${apiUrl}/embed`, {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (!res.ok) {
          console.error(`[petfaces] /embed respondió ${res.status}`);
          return null;
        }
        const body = await res.json();
        return { embedding: body.embedding, model: body.model };
      } catch (e) {
        console.error('[petfaces] no se pudo llamar al servicio de mascotas:', e.message);
        return null;
      }
    }
  };
}

module.exports = { createPetMatcher };
