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
      source TEXT NOT NULL CHECK (source IN ('web','whatsapp','telegram','api')),
      reporter TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_updates_person ON updates(person_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel IN ('email','whatsapp','telegram')),
      address TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      UNIQUE(person_id, channel, address)
    );
    CREATE INDEX IF NOT EXISTS idx_subscriptions_person ON subscriptions(person_id);
  `);

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
    async insertUpdate(personId, { status, message, location, source, reporter }) {
      const info = db
        .prepare(
          'INSERT INTO updates (person_id, status, message, location, source, reporter) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(personId, status, message || null, location || null, source, reporter || null);
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
    async recentUpdates(limit) {
      return db
        .prepare(
          `SELECT u.*, p.full_name FROM updates u JOIN people p ON p.id = u.person_id
           ORDER BY u.created_at DESC, u.id DESC LIMIT ?`
        )
        .all(limit);
    },
    async insertSubscription(personId, channel, address) {
      db.prepare(
        'INSERT OR IGNORE INTO subscriptions (person_id, channel, address) VALUES (?, ?, ?)'
      ).run(personId, channel, address);
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
    async close() {
      db.close();
    }
  };
}

module.exports = { createSqliteAdapter };
