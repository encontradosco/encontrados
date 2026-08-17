// Proveedor de embeddings de mascotas. Producción: el servicio propio
// pet-matcher (repo separado, no vive en este monorepo). Sin
// PET_MATCH_API_URL, el matching de mascotas queda apagado — mismo
// contrato de degradación que src/faces.js tiene para Rekognition: nunca
// lanza, nunca tumba un reporte.
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
    // Nunca la URL acá: /api/diag es público y sin llave, y aunque el
    // servicio exige un secreto compartido (PET_MATCH_SHARED_SECRET, ver
    // require_shared_secret() en app.py del repo de pet-matcher) anunciar
    // su dirección exacta sigue siendo publicarle el blanco a quien quiera
    // pegarle sin que nadie se lo pida.
    status: 'activo',
    async embed(bytes, contentType) {
      try {
        const form = new FormData();
        form.append('image', new Blob([bytes], { type: contentType || 'image/jpeg' }), 'foto.jpg');
        // Se lee PET_MATCH_SHARED_SECRET en cada llamada, no una vez al
        // arrancar — mismo motivo que notify.js: la variable puede cambiar
        // sin reiniciar el proceso. Sin ella no se manda el header: el
        // servicio del otro lado responde 503 (falla cerrado) y esto ya
        // trata cualquier respuesta que no sea 2xx como "no disponible".
        const secret = process.env.PET_MATCH_SHARED_SECRET;
        const res = await fetch(`${apiUrl}/embed`, {
          method: 'POST',
          body: form,
          headers: secret ? { 'x-pet-matcher-secret': secret } : undefined,
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (!res.ok) {
          console.error(`[petfaces] /embed respondió ${res.status}`);
          return null;
        }
        const body = await res.json();
        // Un PET_MATCH_API_URL mal configurado, apuntando a otro servicio
        // cualquiera que responda 200 con JSON, no debe colarse como éxito:
        // sin esto, body.embedding/body.model llegan `undefined` y la fila
        // queda con basura en vez de fallar limpio (mismo defecto que un
        // embedding nunca se borra si nadie lo nota).
        if (!Array.isArray(body.embedding)) {
          console.error('[petfaces] /embed respondió 200 sin un embedding válido');
          return null;
        }
        return { embedding: body.embedding, model: body.model };
      } catch (e) {
        console.error('[petfaces] no se pudo llamar al servicio de mascotas:', e.message);
        return null;
      }
    }
  };
}

module.exports = { createPetMatcher };
