// Shared person/update/subscription logic over a storage adapter (SQLite or Postgres).
// All fuzzy-matching decisions live here so both backends behave identically.
const crypto = require('crypto');
const { normalize, phoneticKey, titleCaseName, matchScore } = require('./names');

const STATUSES = ['safe', 'injured', 'missing', 'deceased', 'unknown'];
// 'aggregator': updates pushed by an external data aggregator, distinct from
// the app's own web/whatsapp/api channels (see POST /api/updates).
const SOURCES = ['web', 'whatsapp', 'api', 'aggregator'];

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

  // Reuse an existing person when the name confidently matches; otherwise create.
  async function findOrCreatePerson(fullName) {
    const norm = normalize(fullName);
    if (!norm) throw new Error('Name is required');
    const exact = await adapter.exactByNormalized(norm);
    if (exact) return { person: isoRow(exact), created: false };
    const [best] = await searchPeople(fullName, { limit: 1, minScore: 0.85 });
    if (best) return { person: await getPerson(best.id), created: false };
    // Only new people are re-cased: an existing row keeps whatever it has, so
    // a correction made by hand isn't undone by the next report.
    const person = await adapter.insertPerson(titleCaseName(fullName), norm, phoneticKey(fullName));
    return { person: isoRow(person), created: true };
  }

  async function addUpdate(personId, { status, message, location, lat, lng, source, reporter, contact, externalId }) {
    if (!STATUSES.includes(status)) throw new Error(`Invalid status: ${status}`);
    return isoRow(
      await adapter.insertUpdate(personId, {
        status,
        message,
        location,
        lat,
        lng,
        source,
        reporter,
        contact,
        externalId
      })
    );
  }

  // Everyone whose latest status is 'missing' — the home page listing.
  async function getMissingPeople(limit = 50) {
    return (await adapter.missingPeople(limit)).map(isoRow);
  }

  // How many people whose latest status is 'safe' — the "reencontrados" counter.
  async function getReunitedCount() {
    return adapter.reunitedCount();
  }

  async function getUpdates(personId) {
    return (await adapter.updatesForPerson(personId)).map(isoRow);
  }

  async function getLatestUpdate(personId) {
    return isoRow(await adapter.latestUpdate(personId));
  }

  async function getRecentUpdates(limit = 20) {
    return (await adapter.recentUpdates(limit)).map(isoRow);
  }

  // Every subscription gets a unique token, used for the unsubscribe link and —
  // for email — the verification link. Email starts unverified; WhatsApp is
  // verified implicitly (the sender messages from their own number).
  async function subscribe(personId, channel, address) {
    const addr0 = String(address || '').trim();
    if (!addr0) throw new Error('Address is required');
    const addr = channel === 'email' ? addr0.toLowerCase() : addr0;
    const existing = await adapter.findSubscription(personId, channel, addr);
    if (existing) {
      return { sub: existing, created: false, needsVerification: channel === 'email' && !existing.verified };
    }
    const token = crypto.randomBytes(16).toString('hex');
    const verified = channel !== 'email';
    const sub = await adapter.insertSubscription(personId, channel, addr, verified, token);
    return { sub, created: true, needsVerification: !verified };
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

  async function getSubscriptionById(id) {
    return adapter.getSubscriptionById(id);
  }

  async function addPhoto(fields) {
    return adapter.insertPhoto(fields);
  }

  async function setPhotoFaceId(photoId, faceId) {
    return adapter.setPhotoFaceId(photoId, faceId);
  }

  async function setPhotoSubscriptionId(photoId, subscriptionId) {
    return adapter.setPhotoSubscriptionId(photoId, subscriptionId);
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

  async function countQueryPhotos(subscriptionId) {
    return adapter.countQueryPhotos(subscriptionId);
  }

  async function photosMissingFaceId(limit = 100) {
    return adapter.photosMissingFaceId(limit);
  }

  async function counts() {
    return adapter.counts();
  }

  // Deletes the person and, by cascade, their reports, subscriptions and photos.
  async function deletePerson(id) {
    return isoRow(await adapter.deletePerson(id));
  }

  return {
    STATUSES,
    SOURCES,
    getPerson,
    searchPeople,
    findOrCreatePerson,
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
    getSubscriptionById,
    addPhoto,
    setPhotoFaceId,
    setPhotoSubscriptionId,
    setPhotoFaceDetail,
    setPhotoThumbnails,
    getPhoto,
    reportPhotoByPerson,
    clearPhotoContent,
    photosByFaceIds,
    countQueryPhotos,
    photosMissingFaceId,
    photosMissingDerivatives,
    counts,
    deletePerson,
    close: () => adapter.close()
  };
}

module.exports = { createStore, STATUSES, SOURCES };
