// SQLite adapter — local development and tests. Zero setup, single file.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

async function createSqliteAdapter(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS people (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      phonetic_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_people_normalized ON people(normalized_name);

    CREATE TABLE IF NOT EXISTS updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('safe','injured','missing','deceased','unknown')),
      message TEXT,
      location TEXT,
      lat REAL,
      lng REAL,
      contact TEXT,
      source TEXT NOT NULL CHECK (source IN ('web','whatsapp','api','aggregator')),
      reporter TEXT,
      external_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_updates_person ON updates(person_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_updates_external_id ON updates(external_id) WHERE external_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel IN ('email','whatsapp')),
      address TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 1,
      verify_token TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      UNIQUE(person_id, channel, address)
    );
    CREATE INDEX IF NOT EXISTS idx_subscriptions_person ON subscriptions(person_id);

    CREATE TABLE IF NOT EXISTS photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('report','query')),
      update_id INTEGER REFERENCES updates(id) ON DELETE CASCADE,
      subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE CASCADE,
      content BLOB NOT NULL,
      content_type TEXT NOT NULL,
      face_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_photos_face ON photos(face_id);
    CREATE INDEX IF NOT EXISTS idx_photos_subscription ON photos(subscription_id);
  `);

  // Older dev databases: add the GPS columns if missing.
  for (const col of ['lat', 'lng']) {
    try {
      db.exec(`ALTER TABLE updates ADD COLUMN ${col} REAL`);
    } catch { /* already exists */ }
  }
  try {
    db.exec('ALTER TABLE updates ADD COLUMN contact TEXT');
  } catch { /* already exists */ }
  // Older dev databases: add external_id if missing. Note: SQLite can't widen
  // an existing CHECK constraint via ALTER TABLE, so a pre-existing local
  // ./data/aqui.db still rejects source='aggregator' until it's recreated
  // (delete the file — it's dev-only and gets rebuilt on next start).
  try {
    db.exec('ALTER TABLE updates ADD COLUMN external_id TEXT');
  } catch { /* already exists */ }
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_updates_external_id ON updates(external_id) WHERE external_id IS NOT NULL'
  );

  const getPersonStmt = db.prepare('SELECT * FROM people WHERE id = ?');

  return {
    async insertPerson(fullName, normalized, phonetic) {
      const info = db
        .prepare('INSERT INTO people (full_name, normalized_name, phonetic_name) VALUES (?, ?, ?)')
        .run(fullName, normalized, phonetic);
      return getPersonStmt.get(info.lastInsertRowid);
    },
    async getPerson(id) {
      return getPersonStmt.get(id);
    },
    async exactByNormalized(normalized) {
      return db.prepare('SELECT * FROM people WHERE normalized_name = ?').get(normalized);
    },
    // Dev-scale: return everyone and let the JS scorer rank. The Postgres
    // adapter prefilters with pg_trgm instead.
    async candidatePeople() {
      return db.prepare('SELECT * FROM people').all();
    },
    // Same idempotent-upsert contract as the Postgres adapter: a repeated
    // externalId updates the existing row's status/message/location/lat/lng/
    // reporter/contact instead of inserting a duplicate. Without externalId,
    // behavior is unchanged.
    async insertUpdate(personId, { status, message, location, lat, lng, source, reporter, contact, externalId }) {
      const extId = externalId || null;
      const info = db
        .prepare(
          `INSERT INTO updates (person_id, status, message, location, lat, lng, source, reporter, contact, external_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE SET
             status = excluded.status,
             message = excluded.message,
             location = excluded.location,
             lat = excluded.lat,
             lng = excluded.lng,
             reporter = excluded.reporter,
             contact = excluded.contact`
        )
        .run(
          personId,
          status,
          message || null,
          location || null,
          Number.isFinite(lat) ? lat : null,
          Number.isFinite(lng) ? lng : null,
          source,
          reporter || null,
          contact || null,
          extId
        );
      // lastInsertRowid isn't reliable on the DO UPDATE path (no new row is
      // inserted), so look up by external_id (guaranteed unique) when we have one.
      if (extId) {
        return db.prepare('SELECT * FROM updates WHERE external_id = ?').get(extId);
      }
      return db.prepare('SELECT * FROM updates WHERE id = ?').get(info.lastInsertRowid);
    },
    async updatesForPerson(personId) {
      return db
        .prepare('SELECT * FROM updates WHERE person_id = ? ORDER BY created_at DESC, id DESC')
        .all(personId);
    },
    async latestUpdate(personId) {
      return db
        .prepare('SELECT * FROM updates WHERE person_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
        .get(personId);
    },
    // Everyone whose LATEST update is 'missing' — not just anyone who was
    // EVER reported missing. Without this, a person later marked 'safe'
    // would stay on this list forever (see reunitedCount below for the
    // matching "found" count).
    async missingPeople(limit) {
      return db
        .prepare(
          `WITH latest AS (
             SELECT u.person_id, u.status, u.created_at,
                    ROW_NUMBER() OVER (PARTITION BY u.person_id ORDER BY u.created_at DESC, u.id DESC) AS rn
             FROM updates u
           ), reports AS (
             SELECT person_id, COUNT(*) AS n FROM updates GROUP BY person_id
           )
           SELECT p.id, p.full_name, l.status, l.created_at AS last_report, r.n AS reports
           FROM people p
           JOIN latest l ON l.person_id = p.id AND l.rn = 1
           JOIN reports r ON r.person_id = p.id
           WHERE l.status = 'missing'
           ORDER BY l.created_at DESC
           LIMIT ?`
        )
        .all(limit);
    },
    // How many people whose LATEST status is 'safe' — the reunited counter.
    // Same "latest status per person" logic as missingPeople above.
    async reunitedCount() {
      return db
        .prepare(
          `WITH latest AS (
             SELECT u.person_id, u.status,
                    ROW_NUMBER() OVER (PARTITION BY u.person_id ORDER BY u.created_at DESC, u.id DESC) AS rn
             FROM updates u
           )
           SELECT COUNT(*) AS n FROM latest WHERE rn = 1 AND status = 'safe'`
        )
        .get().n;
    },
    async recentUpdates(limit) {
      return db
        .prepare(
          `SELECT u.*, p.full_name FROM updates u JOIN people p ON p.id = u.person_id
           ORDER BY u.created_at DESC, u.id DESC LIMIT ?`
        )
        .all(limit);
    },
    async findSubscription(personId, channel, address) {
      return db
        .prepare('SELECT * FROM subscriptions WHERE person_id = ? AND channel = ? AND address = ?')
        .get(personId, channel, address);
    },
    async insertSubscription(personId, channel, address, verified, verifyToken) {
      db.prepare(
        'INSERT OR IGNORE INTO subscriptions (person_id, channel, address, verified, verify_token) VALUES (?, ?, ?, ?, ?)'
      ).run(personId, channel, address, verified ? 1 : 0, verifyToken || null);
      return this.findSubscription(personId, channel, address);
    },
    async verifySubscriptionByToken(token) {
      const sub = db.prepare('SELECT * FROM subscriptions WHERE verify_token = ?').get(token);
      if (!sub) return null;
      db.prepare('UPDATE subscriptions SET verified = 1 WHERE id = ?').run(sub.id);
      return { ...sub, verified: 1 };
    },
    async deleteSubscriptionByToken(token) {
      const sub = db.prepare('SELECT * FROM subscriptions WHERE verify_token = ?').get(token);
      if (!sub) return null;
      db.prepare('DELETE FROM subscriptions WHERE id = ?').run(sub.id);
      return sub;
    },
    async deleteSubscription(personId, channel, address) {
      return db
        .prepare('DELETE FROM subscriptions WHERE person_id = ? AND channel = ? AND address = ?')
        .run(personId, channel, address).changes;
    },
    async deleteSubscriptionsForAddress(channel, address) {
      return db
        .prepare('DELETE FROM subscriptions WHERE channel = ? AND address = ?')
        .run(channel, address).changes;
    },
    async subscriptionsForPerson(personId) {
      return db.prepare('SELECT * FROM subscriptions WHERE person_id = ?').all(personId);
    },
    async getSubscriptionById(id) {
      return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
    },
    async insertPhoto({ personId, kind, updateId, subscriptionId, content, contentType }) {
      const info = db
        .prepare(
          'INSERT INTO photos (person_id, kind, update_id, subscription_id, content, content_type) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(personId, kind, updateId || null, subscriptionId || null, content, contentType);
      return db
        .prepare(
          'SELECT id, person_id, kind, update_id, subscription_id, content_type, face_id, created_at FROM photos WHERE id = ?'
        )
        .get(info.lastInsertRowid);
    },
    async setPhotoFaceId(photoId, faceId) {
      db.prepare('UPDATE photos SET face_id = ? WHERE id = ?').run(faceId, photoId);
    },
    // Links an already-indexed photo to a subscription created AFTER the
    // photo was stored (e.g. a rescuer adds their email post-hoc). Without
    // this, matchStoredPhoto's later lookup by subscription_id would find
    // nothing and silently never notify.
    async setPhotoSubscriptionId(photoId, subscriptionId) {
      db.prepare('UPDATE photos SET subscription_id = ? WHERE id = ?').run(subscriptionId, photoId);
    },
    // Rescue photos are never kept: only the face signature survives.
    async clearPhotoContent(photoId) {
      db.prepare('UPDATE photos SET content = ? WHERE id = ?').run(Buffer.alloc(0), photoId);
    },
    async photosByFaceIds(faceIds) {
      if (!faceIds.length) return [];
      const marks = faceIds.map(() => '?').join(',');
      return db
        .prepare(
          `SELECT id, person_id, kind, update_id, subscription_id, face_id FROM photos WHERE face_id IN (${marks})`
        )
        .all(...faceIds);
    },
    async deletePerson(id) {
      const person = getPersonStmt.get(id);
      if (!person) return null;
      db.prepare('DELETE FROM people WHERE id = ?').run(id);
      return person;
    },
    async counts() {
      const n = (sql) => db.prepare(sql).get().n;
      return {
        people: n('SELECT COUNT(*) AS n FROM people'),
        updates: n('SELECT COUNT(*) AS n FROM updates'),
        subscriptions: n('SELECT COUNT(*) AS n FROM subscriptions'),
        subscriptions_verified: n('SELECT COUNT(*) AS n FROM subscriptions WHERE verified = 1'),
        photos: n('SELECT COUNT(*) AS n FROM photos'),
        photos_indexed: n('SELECT COUNT(*) AS n FROM photos WHERE face_id IS NOT NULL'),
        photos_report: n("SELECT COUNT(*) AS n FROM photos WHERE kind = 'report'"),
        photos_query: n("SELECT COUNT(*) AS n FROM photos WHERE kind = 'query'")
      };
    },
    async photosMissingFaceId(limit) {
      return db
        .prepare('SELECT * FROM photos WHERE face_id IS NULL ORDER BY id LIMIT ?')
        .all(limit);
    },
    async countQueryPhotos(subscriptionId) {
      return db
        .prepare("SELECT COUNT(*) AS n FROM photos WHERE subscription_id = ? AND kind = 'query'")
        .get(subscriptionId).n;
    },
    async close() {
      db.close();
    }
  };
}

module.exports = { createSqliteAdapter };
