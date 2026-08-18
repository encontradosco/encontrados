// Shared person/update/subscription logic over a storage adapter (SQLite or Postgres).
// All fuzzy-matching decisions live here so both backends behave identically.
const crypto = require('crypto');
const { normalize, phoneticKey, titleCaseName, matchScore } = require('./names');

const STATUSES = ['safe', 'injured', 'missing', 'deceased', 'unknown'];
// 'aggregator': updates pushed by an external data aggregator, distinct from
// the app's own web/whatsapp/api channels (see POST /api/updates).
const SOURCES = ['web', 'whatsapp', 'api', 'aggregator'];

// Nombre ancla que POST /rescate (src/routes/web.js) le da a la persona
// "encontrada" que un rescatista fotografía en campo — no tiene nombre real,
// así que se le da uno sintético con un sufijo aleatorio. El panel de
// estadísticas (#132) necesita reconocer estas personas para contar "personas
// fotografiadas por un rescatista", y sin tocar el esquema la única señal que
// existe es este patrón de nombre. Vive acá, exportado, para que web.js (quien
// lo crea) y report.js (quien lo cuenta) compartan la MISMA constante en vez
// de dos copias del mismo string que se puedan desincronizar en silencio.
const RESCUE_ANCHOR_PREFIX = 'Persona rescatada ';
// La forma en la que ese prefijo queda guardado en normalized_name (minúsculas,
// sin tildes) — derivada con la misma normalize() que usa el resto del
// esquema, no una copia a mano de la regla.
const RESCUE_ANCHOR_NORMALIZED_PREFIX = `${normalize(RESCUE_ANCHOR_PREFIX)} `;

// Postgres returns Date objects; SQLite returns strings. Present ISO strings everywhere.
function isoRow(row) {
  if (row && row.created_at instanceof Date) {
    return { ...row, created_at: row.created_at.toISOString().replace(/\.\d{3}Z$/, 'Z') };
  }
  return row;
}

function createStore(adapter) {
  async function getPerson(id) {
    return isoRow(await adapter.getPerson(id));
  }

  // Fuzzy search: adapter prefilters candidates, JS scorer ranks them.
  async function searchPeople(query, { limit = 5, minScore = 0.55 } = {}) {
    const q = normalize(query);
    if (!q) return [];
    const candidates = await adapter.candidatePeople(q, phoneticKey(query));
    return candidates
      .map((p) => ({ ...isoRow(p), score: matchScore(q, p.normalized_name) }))
      .filter((p) => p.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // #150: antes de fusionar por nombre solo (score >= 0.85), busca una señal
  // que CONTRADIGA que sea la misma persona, en vez de subir el umbral —
  // "Jhon" vs "John" puntúa 0.967 y ahí sí hay que fusionar; el número nunca
  // fue el problema, la señal era insuficiente. Departamento es la primera y
  // más barata; el rostro entra SOLO cuando el departamento no puede decidir
  // (falta en alguno de los dos lados), así el costo de una búsqueda en
  // Rekognition lo paga exactamente el caso raro y de más riesgo — a punto de
  // fusionar dos personas —, no cada reporte que llega. Sin ninguna señal
  // real que comparar, el comportamiento es el de siempre: se fusiona.
  //
  // PENDIENTE — edad, la segunda señal que propone el issue, queda afuera:
  // src/sources/colombiatebusca.js ya la parsea (parseAge) pero ese módulo no
  // está conectado a nada en este repo hoy, solo lo usa su propio test.
  // Construir un guardrail alrededor de un dato que no fluye por ningún lado
  // todavía sería alcance especulativo — retomar esto cuando esa integración
  // exista de verdad.
  async function evaluateMerge(candidate, { department, matcher, photoBytes }) {
    const score = candidate.score;
    // El departamento no nulo MÁS RECIENTE entre todos los updates del
    // candidato — no solo el del último update, que puede no traer uno
    // (señalado en revisión del PR: un update de solo-estado no repite el
    // dato de un reporte anterior, y mirar solo ese último dejaba pasar
    // señal que sí existía).
    const candidateDept = await latestDepartmentForPerson(candidate.id);

    let departmentMatch = 'unknown';
    if (department && candidateDept) {
      departmentMatch = department === candidateDept ? 'match' : 'mismatch';
    }
    if (departmentMatch !== 'unknown') {
      return { score, departmentMatch, faceMatch: 'unknown', blocked: departmentMatch === 'mismatch' };
    }

    // Desempate por rostro (propuesta 4 del issue), solo si hay algo que
    // comparar de los dos lados: una firma ya indexada del candidato, y una
    // foto nueva con la que compararla.
    let faceMatch = 'unknown';
    if (matcher && photoBytes && photoBytes.length) {
      const candidateFaceIds = await faceIdsForPerson(candidate.id);
      if (candidateFaceIds.length) {
        try {
          const hits = await matcher.searchByImage(photoBytes);
          faceMatch = hits.some((h) => candidateFaceIds.includes(h.faceId)) ? 'match' : 'mismatch';
        } catch (e) {
          // Un Rekognition caído no puede bloquear un reporte — degrada a
          // "sin señal", como si nunca se hubiera intentado.
          console.error('[people:merge] búsqueda facial falló, se fusiona sin desempate:', e.message);
        }
      }
    }
    return { score, departmentMatch, faceMatch, blocked: faceMatch === 'mismatch' };
  }

  // Reuse an existing person when the name confidently matches; otherwise create.
  //
  // `mergeCheck` en el resultado es null cuando no hubo nada que evaluar
  // (nombre exacto, o ningún candidato por encima del umbral) y un objeto
  // `{ personId, score, departmentMatch, faceMatch, blocked }` cuando sí
  // lo hubo — `personId` ahí es el CANDIDATO evaluado, que si `blocked` es
  // true NO es la persona devuelta en `person` (report-admission.js usa esto
  // para la bitácora, ver src/logbook.js logMerge).
  async function findOrCreatePerson(fullName, { department = null, matcher = null, photoBytes = null } = {}) {
    const norm = normalize(fullName);
    if (!norm) throw new Error('Name is required');
    // PENDIENTE, señalado en revisión: el guardrail de #150 solo corre acá
    // abajo, sobre el candidato FUZZY (score >= 0.85) — un nombre EXACTO
    // (normalizado idéntico) sigue fusionando sin pasar por evaluateMerge,
    // igual que antes de #150. Es el comportamiento previo a este PR, no algo
    // que este PR introdujo, y extenderlo acá es una decisión aparte y más
    // grande: dos personas reales con el mismo nombre exacto son más raras
    // que variantes ortográficas, pero también es el camino que toma el
    // reporte de seguimiento de una familia sobre su propio caso — aplicar el
    // guardrail acá arriesga bloquear justamente eso.
    const exact = await adapter.exactByNormalized(norm);
    if (exact) return { person: isoRow(exact), created: false, mergeCheck: null };
    const [best] = await searchPeople(fullName, { limit: 1, minScore: 0.85 });
    if (best) {
      const check = await evaluateMerge(best, { department, matcher, photoBytes });
      const mergeCheck = { ...check, personId: best.id };
      if (!check.blocked) {
        return { person: await getPerson(best.id), created: false, mergeCheck };
      }
      // El nombre puntuó alto, pero el departamento o el rostro contradicen
      // que sea la misma persona: se crea aparte en vez de fusionar a ciegas.
      // src/duplicates.js sigue disponible para que un operador la revise
      // como candidata, con la señal fuerte a la vista.
      const blockedPerson = await adapter.insertPerson(titleCaseName(fullName), norm, phoneticKey(fullName));
      return { person: isoRow(blockedPerson), created: true, mergeCheck };
    }
    // Only new people are re-cased: an existing row keeps whatever it has, so
    // a correction made by hand isn't undone by the next report.
    const person = await adapter.insertPerson(titleCaseName(fullName), norm, phoneticKey(fullName));
    return { person: isoRow(person), created: true, mergeCheck: null };
  }

  async function addUpdate(personId, { status, message, location, department, lat, lng, source, sourceUrl, reporter, contact, externalId }) {
    if (!STATUSES.includes(status)) throw new Error(`Invalid status: ${status}`);
    return isoRow(
      await adapter.insertUpdate(personId, {
        status,
        message,
        location,
        department,
        lat,
        lng,
        source,
        sourceUrl,
        reporter,
        contact,
        externalId
      })
    );
  }

  // Re-case names stored before titleCaseName existed (or typed straight into
  // the API). Only the display name changes: normalized_name and phonetic_name
  // are case-insensitive, so nothing about matching moves.
  async function updatePersonName(id, fullName) {
    return adapter.updatePersonName(id, fullName);
  }

  async function recasePersonNames(limit = 500) {
    const people = await adapter.allPeople(limit);
    const fixed = [];
    for (const p of people) {
      const cased = titleCaseName(p.full_name);
      if (cased && cased !== p.full_name) {
        await adapter.updatePersonName(p.id, cased);
        fixed.push({ id: p.id, from: p.full_name, to: cased });
      }
    }
    return { checked: people.length, fixed };
  }

  // Everyone reported missing — the home page listing.
  async function getMissingPeople(limit = 50) {
    return (await adapter.missingPeople(limit)).map(isoRow);
  }

  // How many people whose LATEST status is 'safe' — the "reencontradas" count.
  async function getReunitedCount() {
    return adapter.reunitedCount();
  }

  async function getUpdates(personId) {
    return (await adapter.updatesForPerson(personId)).map(isoRow);
  }

  async function getLatestUpdate(personId) {
    return isoRow(await adapter.latestUpdate(personId));
  }

  // Uso interno de evaluateMerge — no hace falta exportarlo, nadie más lo
  // necesita hoy.
  async function latestDepartmentForPerson(personId) {
    return adapter.latestDepartmentForPerson(personId);
  }

  async function getRecentUpdates(limit = 20) {
    return (await adapter.recentUpdates(limit)).map(isoRow);
  }

  // Every subscription gets a unique token, used for the unsubscribe link and —
  // for email — the verification link. Email starts unverified; WhatsApp is
  // verified implicitly (the sender messages from their own number).
  //
  // Ese "implícitamente" vale solo para el bot, donde el número lo entrega Meta
  // y por lo tanto es del que escribe. Un número TECLEADO en un formulario web
  // no trae esa prueba: puede ser el de cualquiera. Quien lo crea puede decirlo
  // con `{ verified: false }` en vez de heredar una suposición que ahí es falsa.
  //
  // `needsVerification` significa una sola cosa: "hay que mandarle el correo de
  // verificación a esta dirección". Sin el calificador de canal, un número de
  // teléfono sin verificar pedía un correo que nunca iba a llegar a ninguna
  // parte, y la API respondía `pending_verification: true` por algo que no
  // estaba pendiente sino que era imposible. Un número NO se verifica por
  // correo: se verifica cuando su dueño escribe desde él.
  async function subscribe(personId, channel, address, { verified: asVerified } = {}) {
    const addr0 = String(address || '').trim();
    if (!addr0) throw new Error('Address is required');
    const addr = channel === 'email' ? addr0.toLowerCase() : addr0;
    const existing = await adapter.findSubscription(personId, channel, addr);
    if (existing) {
      return {
        sub: existing,
        created: false,
        needsVerification: channel === 'email' && !existing.verified
      };
    }
    const token = crypto.randomBytes(16).toString('hex');
    const verified = asVerified === undefined ? channel !== 'email' : !!asVerified;
    const sub = await adapter.insertSubscription(personId, channel, addr, verified, token);
    return { sub, created: true, needsVerification: channel === 'email' && !verified };
  }

  // El estado del reclamo de rescate, aparte de `verified` (ver el esquema).
  // state: 'asked' | 'confirmed' | 'reported' | null
  async function setSubscriptionRescue(id, fields) {
    return adapter.setSubscriptionRescue(id, fields || {});
  }

  async function verifySubscription(token) {
    if (!token) return null;
    return adapter.verifySubscriptionByToken(String(token));
  }

  async function unsubscribeByToken(token) {
    if (!token) return null;
    return adapter.deleteSubscriptionByToken(String(token));
  }

  async function unsubscribe(personId, channel, address) {
    return adapter.deleteSubscription(personId, channel, address);
  }

  async function unsubscribeAll(channel, address) {
    return adapter.deleteSubscriptionsForAddress(channel, address);
  }

  async function getSubscriptions(personId) {
    return adapter.subscriptionsForPerson(personId);
  }

  // Todas las suscripciones de una dirección o número, sin importar a qué
  // persona sigan. Es como se responde "¿a este número le preguntamos algo y
  // sigue esperando respuesta?" cuando llega un mensaje entrante: la única
  // identidad que trae es el número desde el que escribe.
  async function subscriptionsForAddress(channel, address) {
    const addr0 = String(address || '').trim();
    if (!addr0) return [];
    return adapter.subscriptionsForAddress(channel, channel === 'email' ? addr0.toLowerCase() : addr0);
  }

  async function getSubscriptionById(id) {
    return adapter.getSubscriptionById(id);
  }

  async function addPhoto(fields) {
    return adapter.insertPhoto(fields);
  }

  async function setPhotoFaceId(photoId, faceId) {
    return adapter.setPhotoFaceId(photoId, faceId);
  }

  async function setPhotoFaceDetail(photoId, detail) {
    return adapter.setPhotoFaceDetail(photoId, detail);
  }

  // Postgres returns JSONB already parsed; SQLite returns the raw JSON text.
  function withParsedDetail(photo) {
    if (!photo) return photo;
    const raw = photo.face_detail;
    if (typeof raw !== 'string') return photo;
    try {
      return { ...photo, face_detail: JSON.parse(raw) };
    } catch {
      return { ...photo, face_detail: null };
    }
  }

  async function getPhoto(id) {
    return withParsedDetail(await adapter.getPhoto(id));
  }

  // Metadata for one report photo — enough to render it, without pulling the
  // image bytes. Returns null for a rescuer's photo, which is never rendered.
  async function getReportPhotoMeta(id) {
    return withParsedDetail(await adapter.reportPhotoMeta(id));
  }

  // The public listing shows at most one photo per person. Both adapters order
  // by (person_id, has-geometry, id), so the first row per person wins.
  async function reportPhotoByPerson(personIds) {
    const rows = await adapter.reportPhotosForPeople(personIds);
    const byPerson = new Map();
    for (const row of rows) {
      if (!byPerson.has(row.person_id)) byPerson.set(row.person_id, withParsedDetail(row));
    }
    return byPerson;
  }

  async function setPhotoThumbnails(photoId, sizes) {
    return adapter.setPhotoThumbnails(photoId, sizes);
  }

  async function photosMissingDerivatives(limit = 100) {
    return (await adapter.photosMissingDerivatives(limit)).map(withParsedDetail);
  }

  async function clearPhotoContent(photoId) {
    return adapter.clearPhotoContent(photoId);
  }

  async function photosByFaceIds(faceIds) {
    return adapter.photosByFaceIds(faceIds);
  }

  async function photoFaceIdForContent(personId, kind, content) {
    return adapter.photoFaceIdForContent(personId, kind, content);
  }

  async function indexedPhotos() {
    return adapter.indexedPhotos();
  }

  async function countQueryPhotos(subscriptionId) {
    return adapter.countQueryPhotos(subscriptionId);
  }

  async function photosMissingFaceId(limit = 100) {
    return adapter.photosMissingFaceId(limit);
  }

  async function counts() {
    return adapter.counts();
  }

  // Face signatures of every photo anchored to this person — the report photos
  // AND any rescuer 'query' rows attached to a subscription on them. Read this
  // before deletePerson: the cascade takes the photo rows with it.
  async function faceIdsForPerson(personId) {
    return adapter.faceIdsForPerson(personId);
  }

  // Deletes the person and, by cascade, their reports, subscriptions and photos.
  async function deletePerson(id) {
    return isoRow(await adapter.deletePerson(id));
  }

  // Bitácora de coincidencias y envíos (#116, PR 4). Pass-through directo:
  // src/logbook.js ya se encarga de que un fallo acá nunca suba.
  async function insertMatchLog(fields) {
    return adapter.insertMatchLog(fields);
  }

  async function insertContactLog(fields) {
    return adapter.insertContactLog(fields);
  }

  async function insertMergeLog(fields) {
    return adapter.insertMergeLog(fields);
  }

  async function mergeLogCounts(opts) {
    return adapter.mergeLogCounts(opts);
  }

  async function matchLogCounts(opts) {
    return adapter.matchLogCounts(opts);
  }

  async function contactLogCounts(opts) {
    return adapter.contactLogCounts(opts);
  }

  async function matchLogDaily(opts) {
    return adapter.matchLogDaily(opts);
  }

  async function contactLogDaily(opts) {
    return adapter.contactLogDaily(opts);
  }

  async function matchLogEarliest() {
    return adapter.matchLogEarliest();
  }

  async function contactLogEarliest() {
    return adapter.contactLogEarliest();
  }

  // Cifras del panel #132 — pass-through directo, igual que el resto de la
  // bitácora: la lógica de qué significan vive en report.js, no acá.
  async function updatesBeyondFirstBySource() {
    return adapter.updatesBeyondFirstBySource();
  }

  async function queryPhotoPeople() {
    return adapter.queryPhotoPeople();
  }

  async function matchLogSimilarityRows() {
    return adapter.matchLogSimilarityRows();
  }

  return {
    STATUSES,
    SOURCES,
    getPerson,
    searchPeople,
    findOrCreatePerson,
    updatePersonName,
    recasePersonNames,
    addUpdate,
    getUpdates,
    getLatestUpdate,
    getRecentUpdates,
    getMissingPeople,
    getReunitedCount,
    subscribe,
    verifySubscription,
    unsubscribeByToken,
    unsubscribe,
    unsubscribeAll,
    getSubscriptions,
    subscriptionsForAddress,
    getSubscriptionById,
    setSubscriptionRescue,
    addPhoto,
    setPhotoFaceId,
    setPhotoFaceDetail,
    setPhotoThumbnails,
    getPhoto,
    getReportPhotoMeta,
    reportPhotoByPerson,
    clearPhotoContent,
    photosByFaceIds,
    photoFaceIdForContent,
    indexedPhotos,
    countQueryPhotos,
    photosMissingFaceId,
    photosMissingDerivatives,
    counts,
    faceIdsForPerson,
    deletePerson,
    insertMatchLog,
    insertContactLog,
    insertMergeLog,
    mergeLogCounts,
    matchLogCounts,
    contactLogCounts,
    matchLogDaily,
    contactLogDaily,
    matchLogEarliest,
    contactLogEarliest,
    updatesBeyondFirstBySource,
    queryPhotoPeople,
    matchLogSimilarityRows,
    close: () => adapter.close()
  };
}

module.exports = { createStore, STATUSES, SOURCES, RESCUE_ANCHOR_PREFIX, RESCUE_ANCHOR_NORMALIZED_PREFIX };
