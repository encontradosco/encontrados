// Postgres adapter — production (Vercel + Neon/Vercel Postgres).
// Uses pg_trgm (when available) to prefilter fuzzy-search candidates with an index;
// the shared JS scorer in people.js does the final ranking.
const { Pool } = require('pg');

async function createPostgresAdapter(connectionString) {
  const pool = new Pool({
    connectionString,
    max: 3, // serverless: keep pools tiny
    ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? undefined : { rejectUnauthorized: false }
  });

  let hasTrgm = false;
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    hasTrgm = true;
  } catch (e) {
    console.warn('[store:pg] pg_trgm unavailable, fuzzy prefilter falls back to full scan:', e.message);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS people (
      id SERIAL PRIMARY KEY,
      full_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      phonetic_name TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_people_normalized ON people(normalized_name);

    CREATE TABLE IF NOT EXISTS updates (
      id SERIAL PRIMARY KEY,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('safe','injured','missing','deceased','unknown')),
      message TEXT,
      location TEXT,
      source TEXT NOT NULL CHECK (source IN ('web','whatsapp','telegram','api')),
      reporter TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_updates_person ON updates(person_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel IN ('email','whatsapp','telegram')),
      address TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(person_id, channel, address)
    );
    CREATE INDEX IF NOT EXISTS idx_subscriptions_person ON subscriptions(person_id);
  `);
  if (hasTrgm) {
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_people_norm_trgm ON people USING gin (normalized_name gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_people_phon_trgm ON people USING gin (phonetic_name gin_trgm_ops);
    `);
  }

  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const all = async (sql, params) => (await pool.query(sql, params)).rows;

  return {
    async insertPerson(fullName, normalized, phonetic) {
      return one(
        'INSERT INTO people (full_name, normalized_name, phonetic_name) VALUES ($1, $2, $3) RETURNING *',
        [fullName, normalized, phonetic]
      );
    },
    async getPerson(id) {
      return one('SELECT * FROM people WHERE id = $1', [id]);
    },
    async exactByNormalized(normalized) {
      return one('SELECT * FROM people WHERE normalized_name = $1 LIMIT 1', [normalized]);
    },
    async candidatePeople(normalized, phonetic) {
      if (hasTrgm && normalized) {
        // Trigram similarity + substring on either representation; JS scorer ranks.
        return all(
          `SELECT * FROM people
           WHERE normalized_name % $1
              OR phonetic_name % $2
              OR normalized_name ILIKE '%' || $1 || '%'
           LIMIT 500`,
          [normalized, phonetic || '']
        );
      }
      return all('SELECT * FROM people LIMIT 5000');
    },
    async insertUpdate(personId, { status, message, location, source, reporter }) {
      return one(
        `INSERT INTO updates (person_id, status, message, location, source, reporter)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [personId, status, message || null, location || null, source, reporter || null]
      );
    },
    async updatesForPerson(personId) {
      return all('SELECT * FROM updates WHERE person_id = $1 ORDER BY created_at DESC, id DESC', [
        personId
      ]);
    },
    async latestUpdate(personId) {
      return one(
        'SELECT * FROM updates WHERE person_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
        [personId]
      );
    },
    async recentUpdates(limit) {
      return all(
        `SELECT u.*, p.full_name FROM updates u JOIN people p ON p.id = u.person_id
         ORDER BY u.created_at DESC, u.id DESC LIMIT $1`,
        [limit]
      );
    },
    async insertSubscription(personId, channel, address) {
      await pool.query(
        `INSERT INTO subscriptions (person_id, channel, address) VALUES ($1, $2, $3)
         ON CONFLICT (person_id, channel, address) DO NOTHING`,
        [personId, channel, address]
      );
    },
    async deleteSubscription(personId, channel, address) {
      const r = await pool.query(
        'DELETE FROM subscriptions WHERE person_id = $1 AND channel = $2 AND address = $3',
        [personId, channel, address]
      );
      return r.rowCount;
    },
    async deleteSubscriptionsForAddress(channel, address) {
      const r = await pool.query('DELETE FROM subscriptions WHERE channel = $1 AND address = $2', [
        channel,
        address
      ]);
      return r.rowCount;
    },
    async subscriptionsForPerson(personId) {
      return all('SELECT * FROM subscriptions WHERE person_id = $1', [personId]);
    },
    async close() {
      await pool.end();
    }
  };
}

module.exports = { createPostgresAdapter };
