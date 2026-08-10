// Shared person/update/subscription logic over a storage adapter (SQLite or Postgres).
// All fuzzy-matching decisions live here so both backends behave identically.
const { normalize, phoneticKey, matchScore } = require('./names');

const STATUSES = ['safe', 'injured', 'missing', 'deceased', 'unknown'];

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
    const person = await adapter.insertPerson(fullName.trim(), norm, phoneticKey(fullName));
    return { person: isoRow(person), created: true };
  }

  async function addUpdate(personId, { status, message, location, source, reporter }) {
    if (!STATUSES.includes(status)) throw new Error(`Invalid status: ${status}`);
    return isoRow(
      await adapter.insertUpdate(personId, { status, message, location, source, reporter })
    );
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

  async function subscribe(personId, channel, address) {
    const addr = String(address || '').trim();
    if (!addr) throw new Error('Address is required');
    await adapter.insertSubscription(personId, channel, channel === 'email' ? addr.toLowerCase() : addr);
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

  return {
    STATUSES,
    getPerson,
    searchPeople,
    findOrCreatePerson,
    addUpdate,
    getUpdates,
    getLatestUpdate,
    getRecentUpdates,
    subscribe,
    unsubscribe,
    unsubscribeAll,
    getSubscriptions,
    close: () => adapter.close()
  };
}

module.exports = { createStore, STATUSES };
