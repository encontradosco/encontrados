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

const MAX_QUERY_PHOTOS = 3;

function matchText(matchedPerson, similarity, sub) {
  return [
    `🔔 Aquí — posible coincidencia por reconocimiento facial (${Math.round(similarity)}% de similitud).`,
    `Un reporte sobre *${matchedPerson.full_name}* podría corresponder a la persona que buscas.`,
    `Ver reportes: ${env.BASE_URL}/person/${matchedPerson.id}`,
    '',
    '🔒 Privacidad: las fotos nunca se comparten ni se muestran a nadie; solo se usan para comparar rostros.',
    `Para dejar de recibir estos avisos: ${env.BASE_URL}/unsubscribe?token=${sub.verify_token}`
  ].join('\n');
}

async function notifyFaceMatch(store, sub, matchedPerson, similarity) {
  if (!sub) return;
  if (!sub.verified) {
    console.warn(`[facematch] match found but subscription ${sub.id} is unverified — no alert sent`);
    return;
  }
  console.log(
    `[facematch] notifying sub ${sub.id} (${sub.channel}) about ${matchedPerson.full_name} @ ${Math.round(similarity)}%`
  );
  const text = matchText(matchedPerson, similarity, sub);
  if (sub.channel === 'email') {
    await sendEmail(sub.address, `Posible coincidencia sobre la persona que buscas — Aquí`, text);
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
  const faceId = await matcher.indexFace(bytes, id);
  if (faceId) await store.setPhotoFaceId(id, faceId);
  if (!matches.length) return 0;

  const bySimilarity = new Map(matches.map((m) => [m.faceId, m.similarity]));
  const matchedPhotos = (await store.photosByFaceIds([...bySimilarity.keys()])).filter(
    (p) => p.kind !== kind
  );

  let notified = 0;
  for (const mp of matchedPhotos) {
    const similarity = bySimilarity.get(mp.face_id) || 0;
    if (kind === 'report') {
      // Report photo matched someone's query photos → tell that searcher.
      const sub = await store.getSubscriptionById(mp.subscription_id);
      const person = await store.getPerson(personId);
      await notifyFaceMatch(store, sub, person, similarity);
    } else {
      // Query photo matched an existing report → tell THIS searcher.
      const sub = await store.getSubscriptionById(subscriptionId);
      const person = await store.getPerson(mp.person_id);
      await notifyFaceMatch(store, sub, person, similarity);
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

  if (!matcher.enabled) {
    console.warn(
      `[facematch] matcher disabled — photo ${photo.id} stored WITHOUT indexing (will be picked up by /api/reindex)`
    );
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

module.exports = { processPhoto, backfillUnindexedPhotos, MAX_QUERY_PHOTOS };
