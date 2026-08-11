// Orchestrates photo storage + face matching + match notifications.
//
// Two photo kinds:
//   'report' — attached to a status update about a person
//   'query'  — attached to a subscription by someone LOOKING for a person
//
// When a new photo matches stored photos of the OPPOSITE kind, the interested
// subscriber(s) get a notification. The notification NEVER includes any photo:
// photos are never shared with anyone, they are used exclusively for face
// comparison.

const env = require('./env');
const { sendEmail, sendWhatsApp } = require('./notify');
const { storeThumbnail } = require('./thumbs');

const MAX_QUERY_PHOTOS = 3;

// Sent to a rescuer when someone reports the person they rescued as missing.
function matchText(matchedPerson, similarity, sub, contact) {
  return [
    `🔔 encontrados.co — alguien está buscando a la persona que rescataste (${Math.round(similarity)}% de coincidencia facial).`,
    `Reportada como desaparecida: *${matchedPerson.full_name}*`,
    contact ? `Contacto de quien la busca: ${contact}` : null,
    `Detalles del reporte: ${env.BASE_URL}/person/${matchedPerson.id}`,
    '',
    '🔒 Privacidad: la foto que subiste nunca se guardó; solo conservamos su firma facial para poder avisarte.',
    `Para dejar de recibir estos avisos: ${env.BASE_URL}/unsubscribe?token=${sub.verify_token}`
  ]
    .filter(Boolean)
    .join('\n');
}

async function notifyFaceMatch(store, sub, matchedPerson, similarity, contact) {
  if (!sub) return;
  if (!sub.verified) {
    console.warn(`[facematch] match found but subscription ${sub.id} is unverified — no alert sent`);
    return;
  }
  console.log(
    `[facematch] notifying sub ${sub.id} (${sub.channel}) about ${matchedPerson.full_name} @ ${Math.round(similarity)}%`
  );
  const text = matchText(matchedPerson, similarity, sub, contact);
  if (sub.channel === 'email') {
    await sendEmail(sub.address, 'Alguien busca a la persona que rescataste — encontrados.co', text);
  } else if (sub.channel === 'whatsapp') {
    await sendWhatsApp(sub.address, text);
  }
}

// Search the collection for a stored photo, index it, and notify on cross-kind
// matches. Shared by live uploads and the backfill of previously-stored photos.
async function matchStoredPhoto(store, matcher, photo, bytes) {
  const { id, person_id: personId, kind, subscription_id: subscriptionId } = photo;

  // Search BEFORE indexing so the photo never matches itself.
  const matches = await matcher.searchByImage(bytes);
  console.log(`[facematch] photo ${id} (${kind}) → ${matches.length} raw match(es)`);
  const { faceId, geometry } = await matcher.indexFace(bytes, id);
  if (faceId) await store.setPhotoFaceId(id, faceId);
  // Report photos are shown publicly: they get the geometry to draw and the
  // face thumbnail the listing loads instead of the full image.
  if (kind === 'report') await storeThumbnail(store, id, bytes, geometry);
  if (!matches.length) return 0;

  const bySimilarity = new Map(matches.map((m) => [m.faceId, m.similarity]));
  const matchedPhotos = (await store.photosByFaceIds([...bySimilarity.keys()])).filter(
    (p) => p.kind !== kind
  );

  let notified = 0;
  for (const mp of matchedPhotos) {
    const similarity = bySimilarity.get(mp.face_id) || 0;
    if (kind === 'report') {
      // A missing-person report matched a rescued face → alert that rescuer.
      const sub = await store.getSubscriptionById(mp.subscription_id);
      const person = await store.getPerson(personId);
      const latest = await store.getLatestUpdate(personId);
      await notifyFaceMatch(store, sub, person, similarity, latest && latest.contact);
    } else {
      // A rescued face matched an existing report → alert this rescuer.
      const sub = await store.getSubscriptionById(subscriptionId);
      const person = await store.getPerson(mp.person_id);
      const latest = await store.getLatestUpdate(mp.person_id);
      await notifyFaceMatch(store, sub, person, similarity, latest && latest.contact);
    }
    notified++;
  }
  return notified;
}

// Store a photo, then match it. Returns the stored photo row (no bytes).
async function processPhoto(store, matcher, { personId, kind, updateId, subscriptionId, bytes, contentType }) {
  const photo = await store.addPhoto({
    personId,
    kind,
    updateId,
    subscriptionId,
    content: bytes,
    contentType
  });

  // Wake the lazy matcher BEFORE reading `enabled`: it is a getter over the
  // real matcher, which does not exist until something initializes it. On a
  // cold serverless invocation the flag reads false even though Rekognition is
  // perfectly available, and the photo below is stored without indexing — no
  // face geometry for the public overlay, no match for whoever is searching.
  if (typeof matcher.ensureReady === 'function') await matcher.ensureReady();

  if (!matcher.enabled) {
    console.warn(
      `[facematch] matcher disabled — photo ${photo.id} stored WITHOUT indexing (will be picked up by /api/reindex)`
    );
    // The listing still needs something light to show, so build the thumbnail
    // anyway — centred, since nothing told us where the face is.
    if (kind === 'report') await storeThumbnail(store, photo.id, bytes, null);
    return photo;
  }
  try {
    await matchStoredPhoto(store, matcher, photo, bytes);
  } catch (e) {
    // Matching must never break reporting or subscribing.
    console.error('[facematch]', e);
  }
  return photo;
}

// Index photos that were stored while face matching was unavailable, and run
// matching for them so missed coincidences still reach the people waiting.
async function backfillUnindexedPhotos(store, matcher, limit = 100) {
  if (typeof matcher.ensureReady === 'function') await matcher.ensureReady();
  if (!matcher.enabled) {
    return { ok: false, error: 'El reconocimiento facial no está activo.', processed: 0 };
  }
  const pending = await store.photosMissingFaceId(limit);
  let indexed = 0;
  let notified = 0;
  let noFace = 0;
  for (const photo of pending) {
    try {
      const bytes = Buffer.isBuffer(photo.content) ? photo.content : Buffer.from(photo.content);
      notified += await matchStoredPhoto(store, matcher, photo, bytes);
      indexed++;
    } catch (e) {
      console.error(`[facematch:backfill] photo ${photo.id} failed:`, e.message);
      noFace++;
    }
  }
  console.log(
    `[facematch:backfill] pendientes=${pending.length} procesadas=${indexed} avisos=${notified} fallidas=${noFace}`
  );
  return { ok: true, pending: pending.length, processed: indexed, notifications: notified, failed: noFace };
}

// Bring already-stored report photos up to date: the detection geometry the
// public overlay needs, and the face thumbnail the listing loads. Idempotent
// and safe to run repeatedly — it only looks at photos still missing one.
//
// Geometry comes from DetectFaces, not IndexFaces: these photos are already in
// the collection, and re-indexing them would register a duplicate face.
// Thumbnails don't need Rekognition at all, so they are still generated (as a
// centred crop) when face matching is unavailable.
async function backfillPhotoDerivatives(store, matcher, limit = 100) {
  if (typeof matcher.ensureReady === 'function') await matcher.ensureReady();
  const pending = await store.photosMissingDerivatives(limit);
  let thumbs = 0;
  let geometries = 0;
  let waiting = 0;
  let failed = 0;
  let noFace = 0;

  for (const photo of pending) {
    const hasBox = !!(photo.face_detail && photo.face_detail.box);
    const hasThumb = !!(photo.thumb && photo.thumb.length);
    // Already thumbnailed, and only Rekognition could add what's missing.
    // Redoing the centred crop would change nothing, so leave it for later —
    // otherwise this photo looks "pending" forever while matching is down.
    if (hasThumb && !hasBox && !matcher.enabled) {
      waiting++;
      continue;
    }
    try {
      const bytes = Buffer.isBuffer(photo.content) ? photo.content : Buffer.from(photo.content);
      let geometry = hasBox ? photo.face_detail : null;
      if (!geometry && matcher.enabled) {
        geometry = await matcher.detectFace(bytes);
        if (geometry) geometries++;
      }
      const thumb = await storeThumbnail(store, photo.id, bytes, geometry);
      if (thumb) {
        thumbs++;
        if (!geometry && matcher.enabled) {
          // Rekognition looked and found no face. Without a mark, this photo
          // re-enters photosMissingDerivatives on EVERY run and gets a
          // DetectFaces call each time, forever — the pending counter never
          // reaches 0 and the loop burns Rekognition on photos that will
          // never yield a box. storeThumbnail just rewrote face_detail, so
          // the mark goes on top of what it stored.
          await store.setPhotoFaceDetail(photo.id, { crop: thumb.crop, no_face: true });
          noFace++;
        }
      } else {
        failed++;
      }
    } catch (e) {
      console.error(`[facematch:derivatives] photo ${photo.id} failed:`, e.message);
      failed++;
    }
  }

  console.log(
    `[facematch:derivatives] pendientes=${pending.length} miniaturas=${thumbs} geometrias=${geometries} sin_rostro=${noFace} esperando=${waiting} fallidas=${failed}`
  );
  return {
    ok: true,
    // What this run could actually act on. Anything counted in `waiting` needs
    // Rekognition back before it can move.
    processed: pending.length - waiting,
    thumbnails: thumbs,
    geometry: geometries,
    no_face: noFace,
    waiting,
    failed,
    face_matching: matcher.enabled
  };
}

// The rescuer flow: identify who is looking for the person in front of you.
// The photo is NEVER stored — it is compared, its face signature is indexed so
// future reports can reach this rescuer, and the bytes are dropped immediately.
async function identifyRescuedPerson(store, matcher, { bytes, contentType, personId, subscriptionId }) {
  // Same cold-start trap as processPhoto: `enabled` is a getter over the
  // lazily-built real matcher and reads false on a fresh serverless invocation
  // — which would tell the very first rescuer to reach this instance that the
  // service is down while Rekognition sits there available.
  if (typeof matcher.ensureReady === 'function') await matcher.ensureReady();
  if (!matcher.enabled) {
    return { available: false, matches: [] };
  }
  const matches = await matcher.searchByImage(bytes);
  const bySimilarity = new Map(matches.map((m) => [m.faceId, m.similarity]));

  // Index the face so a later missing-person report can alert this rescuer,
  // then immediately drop the image bytes.
  const photo = await store.addPhoto({
    personId,
    kind: 'query',
    subscriptionId,
    content: Buffer.alloc(0),
    contentType
  });
  try {
    const { faceId } = await matcher.indexFace(bytes, photo.id);
    if (faceId) await store.setPhotoFaceId(photo.id, faceId);
    // No geometry is stored for a rescuer's photo: the image is dropped on the
    // next line, so there would be nothing to draw it over.
  } catch (e) {
    console.error('[facematch:rescue] index failed:', e.message);
  }
  await store.clearPhotoContent(photo.id);

  // Which missing-person reports does this face correspond to?
  const found = [];
  const seen = new Set();
  const photos = await store.photosByFaceIds([...bySimilarity.keys()]);
  for (const mp of photos.filter((x) => x.kind === 'report')) {
    if (seen.has(mp.person_id)) continue;
    seen.add(mp.person_id);
    const person = await store.getPerson(mp.person_id);
    if (!person) continue;
    const latest = await store.getLatestUpdate(mp.person_id);
    found.push({
      person,
      similarity: bySimilarity.get(mp.face_id) || 0,
      update: latest
    });
  }
  found.sort((a, b) => b.similarity - a.similarity);
  return { available: true, matches: found, photoId: photo.id };
}

module.exports = {
  processPhoto,
  identifyRescuedPerson,
  backfillUnindexedPhotos,
  backfillPhotoDerivatives,
  MAX_QUERY_PHOTOS
};
