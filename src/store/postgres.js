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
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      source TEXT NOT NULL CHECK (source IN ('web','whatsapp','api')),
      reporter TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_updates_person ON updates(person_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel IN ('email','whatsapp')),
      address TEXT NOT NULL,
      verified BOOLEAN NOT NULL DEFAULT true,
      verify_token TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(person_id, channel, address)
    );
    CREATE INDEX IF NOT EXISTS idx_subscriptions_person ON subscriptions(person_id);

    CREATE TABLE IF NOT EXISTS photos (
      id SERIAL PRIMARY KEY,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('report','query')),
      update_id INTEGER REFERENCES updates(id) ON DELETE CASCADE,
      subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE CASCADE,
      content BYTEA NOT NULL,
      content_type TEXT NOT NULL,
      face_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_photos_face ON photos(face_id);
    CREATE INDEX IF NOT EXISTS idx_photos_subscription ON photos(subscription_id);
  `);
  if (hasTrgm) {
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_people_norm_trgm ON people USING gin (normalized_name gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_people_phon_trgm ON people USING gin (phonetic_name gin_trgm_ops);
    `);
  }

  await pool.query('ALTER TABLE updates ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION');
  await pool.query('ALTER TABLE updates ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION');

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
    async insertUpdate(personId, { status, message, location, lat, lng, source, reporter }) {
      return one(
        `INSERT INTO updates (person_id, status, message, location, lat, lng, source, reporter)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          personId,
          status,
          message || null,
          location || null,
          Number.isFinite(lat) ? lat : null,
          Number.isFinite(lng) ? lng : null,
          source,
          reporter || null
        ]
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
    async findSubscription(personId, channel, address) {
      return one(
        'SELECT * FROM subscriptions WHERE person_id = $1 AND channel = $2 AND address = $3',
        [personId, channel, address]
      );
    },
    async insertSubscription(personId, channel, address, verified, verifyToken) {
      await pool.query(
        `INSERT INTO subscriptions (person_id, channel, address, verified, verify_token)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (person_id, channel, address) DO NOTHING`,
        [personId, channel, address, !!verified, verifyToken || null]
      );
      return this.findSubscription(personId, channel, address);
    },
    async verifySubscriptionByToken(token) {
      return one('UPDATE subscriptions SET verified = true WHERE verify_token = $1 RETURNING *', [
        token
      ]);
    },
    async deleteSubscriptionByToken(token) {
      return one('DELETE FROM subscriptions WHERE verify_token = $1 RETURNING *', [token]);
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
    async getSubscriptionById(id) {
      return one('SELECT * FROM subscriptions WHERE id = $1', [id]);
    },
    async insertPhoto({ personId, kind, updateId, subscriptionId, content, contentType }) {
      return one(
        `INSERT INTO photos (person_id, kind, update_id, subscription_id, content, content_type)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, person_id, kind, update_id, subscription_id, content_type, face_id, created_at`,
        [personId, kind, updateId || null, subscriptionId || null, content, contentType]
      );
    },
    async setPhotoFaceId(photoId, faceId) {
      await pool.query('UPDATE photos SET face_id = $1 WHERE id = $2', [faceId, photoId]);
    },
    async photosByFaceIds(faceIds) {
      if (!faceIds.length) return [];
      return all(
        'SELECT id, person_id, kind, update_id, subscription_id, face_id FROM photos WHERE face_id = ANY($1)',
        [faceIds]
      );
    },
    async countQueryPhotos(subscriptionId) {
      const r = await one(
        "SELECT COUNT(*)::int AS n FROM photos WHERE subscription_id = $1 AND kind = 'query'",
        [subscriptionId]
      );
      return r.n;
    },
    async close() {
      await pool.end();
    }
  };
}

module.exports = { createPostgresAdapter };
