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
const {
  sendEmail,
  sendWhatsApp,
  relayEnabled,
  relayToOperators,
  rescueConfirmTemplate,
  whatsappTemplateLocale
} = require('./notify');
const { storeThumbnail } = require('./thumbs');
const { toMatchable } = require('./photo');

const MAX_QUERY_PHOTOS = 3;

// Sent to a rescuer when someone reports the person they rescued as missing.
// `similarity` puede venir vacío: la entrega confirmada por WhatsApp ocurre
// horas después de la coincidencia y ya nadie guarda el porcentaje.
function matchText(matchedPerson, similarity, sub, contact) {
  const pct = similarity == null ? '' : ` (${Math.round(similarity)}% de coincidencia facial)`;
  return [
    `🔔 encontrados.co — alguien está buscando a la persona que rescataste${pct}.`,
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
  // Que la suscripción no esté verificada NO es motivo para tirar el aviso.
  //
  // El corte existe para no escribirle a una dirección que quizá no es de quien
  // la escribió, y eso solo puede pasar en el ENVÍO directo. En modo relevo no
  // sale nada hacia afuera: el aviso va al buzón del operador para que una
  // persona decida. Cortar arriba de la bifurcación no protegía a un tercero,
  // nos tapaba la información a nosotros — la coincidencia se descartaba y ni
  // el operador se enteraba, justo en los casos que más necesitan un humano.
  //
  // Así que el corte baja al camino de envío, y el relevo se entera de que la
  // suscripción no está verificada, que es un dato que cambia lo que un humano
  // decide hacer con el aviso.
  const unverified = !sub.verified;
  console.log(
    `[facematch] notifying sub ${sub.id} (${sub.channel}${unverified ? ', SIN verificar' : ''}) about ${matchedPerson.full_name}` +
      (similarity == null ? '' : ` @ ${Math.round(similarity)}%`)
  );
  const text = matchText(matchedPerson, similarity, sub, contact);
  const subject = 'Alguien busca a la persona que rescataste — encontrados.co';

  // El aviso más sensible de la app: su cuerpo lleva el contacto de la familia
  // y su destinatario es alguien que dice haber rescatado a la persona, sin que
  // nadie lo haya verificado. En modo relevo no sale solo.
  if (relayEnabled()) {
    await relayToOperators({
      reason:
        'Coincidencia facial con quien dice haber rescatado a esta persona' +
        (unverified ? ' (suscripción SIN verificar)' : ''),
      channel: sub.channel,
      address: sub.address,
      subject,
      text,
      person: matchedPerson,
      details: [
        similarity == null ? null : `Coincidencia facial: ${Math.round(similarity)}%`,
        unverified
          ? '⚠️ La suscripción NO está verificada: nadie ha comprobado que esa dirección o ese número sean de quien dice haber rescatado a la persona.'
          : 'La suscripción está verificada por su titular.',
        contact
          ? `Contacto de quien la busca (no entregarlo sin verificar): ${contact}`
          : 'El reporte no trae contacto de quien la busca.'
      ].filter(Boolean)
    });
    return;
  }

  // Envío directo: acá sí, nunca a una dirección que su dueño no confirmó.
  if (unverified) {
    console.warn(
      `[facematch] subscription ${sub.id} is unverified — relevado, pero NUNCA enviado directo`
    );
    return;
  }

  if (sub.channel === 'email') {
    await sendEmail(sub.address, subject, text);
  } else if (sub.channel === 'whatsapp') {
    await sendWhatsApp(sub.address, text);
  }
}

// ------------------------------------------- primer contacto con un rescatista
//
// La coincidencia solo existía en la pantalla: si el rescatista cerraba la
// página, no quedaba forma de volver a llegarle. Ahora también sale por sus
// canales, y cada uno tiene su propia regla porque lo que prueban es distinto.
//
//   Correo   — puede llevar los datos. La dirección la acaba de teclear quien
//              está viendo ese mismo contacto en pantalla, así que el mensaje
//              no expone nada nuevo. Igual pasa por notifyFaceMatch: sin
//              verificar va al relevo, jamás a un envío directo.
//   WhatsApp — no puede. Un número tecleado no lo comprueba nadie, y mandarle
//              el teléfono de una familia a un número desconocido es el vector
//              de extorsión que este servicio no puede abrir. Sale la PLANTILLA
//              de confirmación, sin un solo dato de la familia, y la entrega
//              espera a que respondan.
async function notifyRescuerOfMatches(store, { emailSub, phone, matches }) {
  if (!matches || !matches.length) return;
  for (const m of matches) {
    if (emailSub) {
      await notifyFaceMatch(store, emailSub, m.person, m.similarity, m.update && m.update.contact);
    }
  }
  // Una sola pregunta, por la coincidencia más fuerte (matches viene ordenado):
  // preguntar por dos personas distintas convierte un "sí" en una respuesta
  // ambigua, y de esa respuesta depende a quién se le entrega un teléfono.
  if (phone && matches[0]) {
    const top = matches[0];
    await requestRescueConfirmation(store, phone, top.person, top.update && top.update.contact);
  }
}

// Paso 1 de la entrega en dos pasos: preguntar, sin entregar nada.
//
// La suscripción nace SIN verificar y esa fila es el estado pendiente: "a este
// número le preguntamos por esta persona y todavía no responde". El paso 2 no
// tiene otra forma de saber que la pregunta existió, y sin esa comprobación
// cualquiera podría escribir "sí" y cosechar el contacto de una familia.
async function requestRescueConfirmation(store, address, person, contact) {
  const { sub } = await store.subscribe(person.id, 'whatsapp', address, { verified: false });
  if (sub.verified) {
    // Este número ya confirmó antes por esta persona: no hay nada que preguntar
    // de nuevo, y el aviso sigue el camino de siempre.
    await notifyFaceMatch(store, sub, person, null, contact);
    return { asked: false, sub };
  }
  const name = rescueConfirmTemplate();
  if (!name) {
    console.warn(
      `[facematch:rescate] WHATSAPP_TEMPLATE_RESCUE_CONFIRM sin configurar — no se le preguntó nada a ${address}`
    );
    return { asked: false, sub };
  }
  const res = await sendWhatsApp(address, null, {
    template: { name, locale: whatsappTemplateLocale(), params: [person.full_name] }
  });
  if (!res.ok) {
    console.error(`[facematch:rescate] la plantilla a ${address} no salió: ${res.error || res.status}`);
  }
  return { asked: !!res.ok, sub };
}

// Paso 2: alguien respondió que sí, desde su propio número.
//
// Esa respuesta hace dos cosas a la vez — prueba que el número le pertenece y
// afirma que tiene a la persona consigo — y por eso reemplaza al enlace de
// verificación que usa el correo, con algo que además confirma el hecho y no
// solo la dirección.
//
// La entrega sale por notifyFaceMatch, no por un camino propio: en modo relevo
// sigue pasando por un humano, que es la regla de la casa y no cambia porque
// ahora tengamos una confirmación en banda.
//
// Devuelve null si ese número no tenía nada pendiente — ahí "sí" es una palabra
// cualquiera y el mensaje se procesa como siempre.
async function deliverConfirmedRescueContacts(store, address, { maxAgeHours = 72 } = {}) {
  if (typeof store.subscriptionsForAddress !== 'function') return null;
  const subs = await store.subscriptionsForAddress('whatsapp', address);
  const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
  // Una pregunta de hace un mes ya no es una conversación: contestarla no
  // prueba nada sobre dónde está hoy la persona.
  const pending = subs.filter((s) => {
    if (s.verified) return false;
    const at = Date.parse(s.created_at);
    return Number.isNaN(at) || at >= cutoff;
  });
  if (!pending.length) return null;

  const delivered = [];
  for (const s of pending) {
    await store.verifySubscription(s.verify_token);
    const person = await store.getPerson(s.person_id);
    const latest = person ? await store.getLatestUpdate(person.id) : null;
    // El ancla que crea /rescate no tiene reportes: no hay contacto que
    // entregar, y su suscripción solo existe para avisos futuros.
    if (!person || !latest) continue;
    delivered.push(person.full_name);
    await notifyFaceMatch(store, { ...s, verified: true }, person, null, latest.contact);
  }
  console.log(
    `[facematch:rescate] confirmación de ${address}: ${pending.length} pendiente(s), ${delivered.length} entrega(s)`
  );
  return { confirmed: pending.length, delivered };
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
  // Convert before storing, not just before matching: the stored bytes are
  // what GET /photo/:id later hands to a browser, and a HEIC renders as a
  // broken image everywhere except Safari.
  const usable = await toMatchable(bytes, contentType);

  const photo = await store.addPhoto({
    personId,
    kind,
    updateId,
    subscriptionId,
    content: usable ? usable.bytes : bytes,
    contentType: usable ? usable.contentType : contentType
  });

  if (!usable) {
    // The report itself is the family's data and is already durable — losing
    // it over an unreadable attachment is never the right trade. But the photo
    // cannot do the one job it was uploaded for, so mark it and let the caller
    // say so out loud rather than let the person believe the face is indexed.
    console.warn(
      `[facematch] photo ${photo.id} ilegible (${contentType}) — guardada sin indexar ni miniatura`
    );
    photo.unreadable = true;
    return photo;
  }
  const content = usable.bytes;

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
    if (kind === 'report') await storeThumbnail(store, photo.id, content, null);
    return photo;
  }
  try {
    await matchStoredPhoto(store, matcher, photo, content);
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
//
// `searchOnly` apaga esa indexación: compara contra la colección, devuelve las
// coincidencias y NO deja nada — ni firma facial en Rekognition, ni fila de
// foto, ni la persona ancla que las sostiene.
//
// El costo es exactamente la funcionalidad más valiosa: sin firma indexada, esa
// consulta NUNCA va a recibir el aviso posterior de "alguien reportó a esta
// persona". La opción que da más privacidad quita la que más sirve, y por eso
// no es el comportamiento por omisión de nadie: es una casilla que alguien
// marca a sabiendas, con el costo escrito al lado.
async function identifyRescuedPerson(
  store,
  matcher,
  { bytes, contentType, personId, subscriptionId, searchOnly = false }
) {
  // Same cold-start trap as processPhoto: `enabled` is a getter over the
  // lazily-built real matcher and reads false on a fresh serverless invocation
  // — which would tell the very first rescuer to reach this instance that the
  // service is down while Rekognition sits there available.
  if (typeof matcher.ensureReady === 'function') await matcher.ensureReady();
  if (!matcher.enabled) {
    return { available: false, matches: [] };
  }

  // A format Rekognition refuses used to throw straight through this function
  // and out of the route, and the rescuer — holding a person, in the field —
  // got "Error interno del servidor" and no idea what to do next.
  const usable = await toMatchable(bytes, contentType);
  if (!usable) return { available: true, unreadable: true, matches: [] };

  let matches;
  try {
    matches = await matcher.searchByImage(usable.bytes);
  } catch (e) {
    // searchByImage already treats "no face in this image" as an empty result,
    // so anything landing here is Rekognition itself failing. Degrade to "try
    // again in a moment"; never a 500 on the one screen a rescuer is using.
    console.error('[facematch:rescue] búsqueda fallida:', e.name, e.message);
    return { available: false, matches: [] };
  }
  const bySimilarity = new Map(matches.map((m) => [m.faceId, m.similarity]));

  // Index the face so a later missing-person report can alert this rescuer,
  // then immediately drop the image bytes. En modo solo-búsqueda esto es
  // justamente lo que no pasa: la consulta se resuelve con lo que ya está
  // indexado y no agrega nada a la colección.
  let photo = null;
  if (!searchOnly) {
    photo = await store.addPhoto({
      personId,
      kind: 'query',
      subscriptionId,
      content: Buffer.alloc(0),
      contentType: usable.contentType
    });
    try {
      const { faceId } = await matcher.indexFace(usable.bytes, photo.id);
      if (faceId) await store.setPhotoFaceId(photo.id, faceId);
      // No geometry is stored for a rescuer's photo: the image is dropped on
      // the next line, so there would be nothing to draw it over.
    } catch (e) {
      console.error('[facematch:rescue] index failed:', e.message);
    }
    await store.clearPhotoContent(photo.id);
  }

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
  return { available: true, matches: found, photoId: photo ? photo.id : null, indexed: !!photo };
}

module.exports = {
  processPhoto,
  identifyRescuedPerson,
  notifyRescuerOfMatches,
  requestRescueConfirmation,
  deliverConfirmedRescueContacts,
  backfillUnindexedPhotos,
  backfillPhotoDerivatives,
  MAX_QUERY_PHOTOS
};
