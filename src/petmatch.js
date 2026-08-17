// Orquestación de mascotas — espejo de src/facematch.js, pero comparando
// embeddings en JS en vez de usar la colección administrada de Rekognition:
// el servicio pet-matcher (repo separado, no vive en este monorepo — ver
// PET_MATCH_API_URL en agent.md) solo calcula vectores, no compara nada.
//
// Dos tipos de foto, igual que con personas:
//   'report' — mascota reportada como perdida. Se guarda y se publica.
//   'query'  — foto de quien encontró una mascota. Se compara y se borra —
//              solo el embedding sobrevive, nunca los bytes.
const { toMatchable } = require('./photo');
const { makeThumbnail } = require('./thumbs');

const PET_MATCH_THRESHOLD = parseFloat(process.env.PET_MATCH_THRESHOLD || '80');

// Tope duro de coincidencias devueltas por una comparación — mismo espíritu
// que MaxFaces/MAX_QUERY_PHOTOS ya usan en el lado de personas: sin esto, una
// foto genérica (un perro café común) podría devolver decenas de "posibles"
// avistamientos, que no ayudan a nadie a decidir nada.
const MAX_PET_MATCHES = 5;

function cosineSimilarity(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Compara contra el lado OPUESTO (report ⟷ query), filtrando por especie —
// nunca cruza perro con gato — y por MODELO: dos embeddings de modelos
// distintos viven en espacios vectoriales distintos, así que una similitud
// coseno entre ellos no significa nada, aunque el número salga "razonable".
// Si el modelo cambia alguna vez, las fotos viejas simplemente dejan de
// compararse contra las nuevas hasta que se reindexen — mejor eso que una
// coincidencia (o un descarte) sin sentido. petPhotosForMatching ya excluye
// del lado de 'report' cualquier foto de una mascota marcada como resuelta
// (resolved_at) — mostrar como "posible avistamiento" a una mascota que ya se
// encontró no ayuda a nadie y confunde. Devuelve [{ id, pet_id, similarity }]
// ordenado de mayor a menor similitud, solo por encima del umbral, y nunca
// más de MAX_PET_MATCHES filas.
async function matchPetPhoto(petStore, { kind, species, embedding, model }) {
  const oppositeKind = kind === 'report' ? 'query' : 'report';
  const candidates = await petStore.petPhotosForMatching(oppositeKind, species);
  return candidates
    .filter((c) => c.embedding_model === model)
    .map((c) => ({ ...c, similarity: cosineSimilarity(embedding, c.embedding) * 100 }))
    .filter((c) => c.similarity >= PET_MATCH_THRESHOLD)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, MAX_PET_MATCHES);
}

// Guarda la foto, pide su embedding, compara, y (solo para kind='report')
// genera la miniatura que ve la ficha pública. Nunca lanza: un servicio de
// embeddings caído apaga el matching, no tumba el reporte — mismo principio
// que processPhoto en facematch.js.
async function processPetPhoto(petStore, petMatcher, { petId, kind, species, subscriptionId, bytes, contentType }) {
  const usable = await toMatchable(bytes, contentType);

  const photo = await petStore.addPetPhoto({
    petId: petId || null,
    kind,
    species,
    subscriptionId: subscriptionId || null,
    content: usable ? usable.bytes : bytes,
    contentType: usable ? usable.contentType : contentType
  });

  if (!usable) {
    console.warn(`[petmatch] foto ${photo.id} ilegible (${contentType}) — guardada sin comparar`);
    photo.unreadable = true;
    // Incondicional, no solo para 'query': lo que se guardó arriba es el
    // content_type que declaró quien subió el archivo, sin verificar — es
    // precisamente lo que toMatchable() ya rechazó. Servirlo tal cual en
    // GET /pet-photo/:id (que solo revisa que haya bytes, nunca el tipo)
    // abriría un XSS almacenado en este origen con un archivo declarado
    // como imagen pero servido como text/html. Sin contenido, esa ruta ya
    // devuelve 404 antes de llegar al res.set(Content-Type).
    await petStore.clearPetPhotoContent(photo.id);
    return { photo, matches: [] };
  }
  const content = usable.bytes;

  if (kind === 'report') {
    const thumb = await makeThumbnail(content, null);
    if (thumb) await petStore.setPetPhotoThumbnail(photo.id, { small: thumb.bytes, contentType: thumb.contentType });
  }

  if (!petMatcher.enabled) {
    console.warn(`[petmatch] matcher deshabilitado — foto ${photo.id} guardada sin comparar (backfill la recoge después)`);
    if (kind === 'query') await petStore.clearPetPhotoContent(photo.id);
    return { photo, matches: [] };
  }

  const result = await petMatcher.embed(content, contentType);
  if (!result) {
    if (kind === 'query') await petStore.clearPetPhotoContent(photo.id);
    return { photo, matches: [] };
  }

  // Guardar el embedding y comparar pueden fallar por su cuenta (un error de
  // base transitorio, verosímil en un despliegue serverless) sin que eso sea
  // motivo para tumbar el reporte ni, sobre todo, para saltarse el borrado de
  // los bytes de una foto 'query' más abajo — por eso ese borrado vive FUERA
  // de este try, incondicional una vez que embed() ya tuvo éxito. Mismo
  // patrón que identifyRescuedPerson en facematch.js: el intento de indexar
  // puede fallar, pero clearPhotoContent corre igual.
  let matches = [];
  try {
    await petStore.setPetPhotoEmbedding(photo.id, result.embedding, result.model);
    matches = await matchPetPhoto(petStore, { kind, species, embedding: result.embedding, model: result.model });
  } catch (e) {
    console.error(`[petmatch] error guardando o comparando el embedding de la foto ${photo.id}:`, e.message);
  }

  // La foto de quien encontró una mascota nunca se conserva — solo su
  // embedding, para que un reporte futuro sí pueda coincidir con ella. Corre
  // pase lo que pase arriba: aunque guardar el embedding o comparar hayan
  // fallado, los bytes de una foto 'query' no se quedan en la base.
  if (kind === 'query') await petStore.clearPetPhotoContent(photo.id);

  if (kind === 'report' && matches.length) {
    // Hoy no hay contacto de quien encontró la mascota (pet_subscriptions
    // existe pero no se usa todavía — ver el plan), así que no hay a quién
    // avisar de este lado. Se deja visible en el log para operación.
    console.log(
      `[petmatch] el reporte de la mascota ${photo.pet_id} coincide con ${matches.length} avistamiento(s) previo(s), sin contacto para avisar en esta versión`
    );
  }

  return { photo, matches };
}

// Red de seguridad: fotos que quedaron sin embedding porque el servicio
// estaba caído o sin configurar al momento de subirlas. Mismo rol que
// backfillUnindexedPhotos en facematch.js — no es el camino principal.
async function backfillUnindexedPetPhotos(petStore, petMatcher, limit = 100) {
  if (!petMatcher.enabled) {
    return { ok: false, error: 'El servicio de mascotas no está activo.', processed: 0 };
  }
  const pending = await petStore.petPhotosMissingEmbedding(limit);
  let processed = 0;
  let failed = 0;
  for (const photo of pending) {
    try {
      const bytes = Buffer.isBuffer(photo.content) ? photo.content : Buffer.from(photo.content);
      const result = await petMatcher.embed(bytes, photo.content_type);
      if (result) {
        await petStore.setPetPhotoEmbedding(photo.id, result.embedding, result.model);
        processed++;
      } else {
        failed++;
      }
    } catch (e) {
      console.error(`[petmatch:backfill] foto ${photo.id} falló:`, e.message);
      failed++;
    } finally {
      // Incondicional al resultado — que embed() haya fallado o lanzado no es
      // motivo para dejar los bytes de una foto 'query' un reintento más:
      // mismo principio que el borrado de processPetPhoto arriba, fuera de
      // cualquier try/catch de comparación.
      if (photo.kind === 'query') await petStore.clearPetPhotoContent(photo.id);
    }
  }
  return { ok: true, pending: pending.length, processed, failed };
}

module.exports = { processPetPhoto, backfillUnindexedPetPhotos, PET_MATCH_THRESHOLD, MAX_PET_MATCHES, cosineSimilarity };
