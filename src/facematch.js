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
  if (!sub || !sub.verified) return;
  const text = matchText(matchedPerson, similarity, sub);
  if (sub.channel === 'email') {
    await sendEmail(sub.address, `Posible coincidencia sobre la persona que buscas — Aquí`, text);
  } else if (sub.channel === 'whatsapp') {
    await sendWhatsApp(sub.address, text);
  }
}

// Store a photo, search the face collection, index the new face, and notify on
// cross-kind matches. Returns the stored photo row (metadata only, no bytes).
async function processPhoto(store, matcher, { personId, kind, updateId, subscriptionId, bytes, contentType }) {
  const photo = await store.addPhoto({
    personId,
    kind,
    updateId,
    subscriptionId,
    content: bytes,
    contentType
  });

  try {
    // Search BEFORE indexing so the photo never matches itself.
    const matches = await matcher.searchByImage(bytes);
    const faceId = await matcher.indexFace(bytes, photo.id);
    if (faceId) await store.setPhotoFaceId(photo.id, faceId);
    if (!matches.length) return photo;

    const bySimilarity = new Map(matches.map((m) => [m.faceId, m.similarity]));
    const matchedPhotos = (await store.photosByFaceIds([...bySimilarity.keys()])).filter(
      (p) => p.kind !== kind
    );

    for (const mp of matchedPhotos) {
      const similarity = bySimilarity.get(mp.face_id) || 0;
      if (kind === 'report') {
        // New report photo matched someone's query photos → tell that searcher.
        const sub = await store.getSubscriptionById(mp.subscription_id);
        const person = await store.getPerson(personId);
        await notifyFaceMatch(store, sub, person, similarity);
      } else {
        // New query photo matched an existing report → tell THIS searcher.
        const sub = await store.getSubscriptionById(subscriptionId);
        const person = await store.getPerson(mp.person_id);
        await notifyFaceMatch(store, sub, person, similarity);
      }
    }
  } catch (e) {
    // Matching must never break reporting or subscribing.
    console.error('[facematch]', e);
  }
  return photo;
}

module.exports = { processPhoto, MAX_QUERY_PHOTOS };
