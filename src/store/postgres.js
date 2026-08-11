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
      contact TEXT,
      source TEXT NOT NULL CHECK (source IN ('web','whatsapp','api','aggregator')),
      reporter TEXT,
      external_id TEXT,
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
      face_detail JSONB,
      thumb BYTEA,
      thumb_type TEXT,
      thumb_large BYTEA,
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
  await pool.query('ALTER TABLE updates ADD COLUMN IF NOT EXISTS contact TEXT');
  // Detection geometry (bounding box + landmarks) for the public overlay, and
  // the face thumbnail the public listing loads instead of the full photo.
  await pool.query('ALTER TABLE photos ADD COLUMN IF NOT EXISTS face_detail JSONB');
  await pool.query('ALTER TABLE photos ADD COLUMN IF NOT EXISTS thumb BYTEA');
  await pool.query('ALTER TABLE photos ADD COLUMN IF NOT EXISTS thumb_type TEXT');
  await pool.query('ALTER TABLE photos ADD COLUMN IF NOT EXISTS thumb_large BYTEA');

  // Integration seam for an external aggregator: external_id lets a caller
  // re-POST the same update idempotently (see insertUpdate below), and
  // 'aggregator' is a real source distinct from the app's own web/whatsapp/api.
  await pool.query('ALTER TABLE updates ADD COLUMN IF NOT EXISTS external_id TEXT');
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_updates_external_id
      ON updates(external_id) WHERE external_id IS NOT NULL
  `);
  // Widen the source CHECK for DBs created before 'aggregator' existed.
  // Cheap on this table's scale; matches the ADD COLUMN IF NOT EXISTS pattern above.
  await pool.query('ALTER TABLE updates DROP CONSTRAINT IF EXISTS updates_source_check');
  await pool.query(`
    ALTER TABLE updates ADD CONSTRAINT updates_source_check
      CHECK (source IN ('web','whatsapp','api','aggregator'))
  `);

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
    async allPeople(limit) {
      return all('SELECT id, full_name FROM people ORDER BY id LIMIT $1', [limit]);
    },
    async updatePersonName(id, fullName) {
      await pool.query('UPDATE people SET full_name = $1 WHERE id = $2', [fullName, id]);
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
    // When externalId is set, this is an idempotent upsert keyed on it: a
    // second POST with the same externalId updates status/message/location/
    // lat/lng/reporter/contact on the SAME timeline row instead of creating a
    // new one (the aggregator re-sending its latest snapshot doesn't duplicate
    // the person's history). Without externalId, behavior is unchanged: a
    // plain insert every time.
    async insertUpdate(personId, { status, message, location, lat, lng, source, reporter, contact, externalId }) {
      return one(
        `INSERT INTO updates (person_id, status, message, location, lat, lng, source, reporter, contact, external_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE SET
           status = EXCLUDED.status,
           message = EXCLUDED.message,
           location = EXCLUDED.location,
           lat = EXCLUDED.lat,
           lng = EXCLUDED.lng,
           reporter = EXCLUDED.reporter,
           contact = EXCLUDED.contact
         RETURNING *`,
        [
          personId,
          status,
          message || null,
          location || null,
          Number.isFinite(lat) ? lat : null,
          Number.isFinite(lng) ? lng : null,
          source,
          reporter || null,
          contact || null,
          externalId || null
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
    async getUpdate(id) {
      return one('SELECT * FROM updates WHERE id = $1', [id]);
    },
    // Everyone currently reported missing, most recent report first.
    async missingPeople(limit) {
      return all(
        `SELECT p.id, p.full_name, MAX(u.created_at) AS last_report, COUNT(u.id)::int AS reports
         FROM people p JOIN updates u ON u.person_id = p.id
         WHERE u.status = 'missing'
         GROUP BY p.id, p.full_name
         ORDER BY last_report DESC
         LIMIT $1`,
        [limit]
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
    async setPhotoFaceDetail(photoId, detail) {
      await pool.query('UPDATE photos SET face_detail = $1 WHERE id = $2', [
        detail ? JSON.stringify(detail) : null,
        photoId
      ]);
    },
    async setPhotoThumbnails(photoId, { small, large, contentType }) {
      await pool.query(
        'UPDATE photos SET thumb = $1, thumb_large = $2, thumb_type = $3 WHERE id = $4',
        [small, large, contentType, photoId]
      );
    },
    async getPhoto(id) {
      return one('SELECT * FROM photos WHERE id = $1', [id]);
    },
    // One photo per person for the public listing: the earliest report photo
    // that still has bytes and, preferably, a thumbnail to show.
    async reportPhotosForPeople(personIds) {
      if (!personIds.length) return [];
      return all(
        `SELECT DISTINCT ON (person_id) id, person_id, content_type, face_id, face_detail, thumb_type
         FROM photos
         WHERE kind = 'report' AND person_id = ANY($1) AND octet_length(content) > 0
         ORDER BY person_id, (thumb IS NULL), (thumb_large IS NULL), (face_detail IS NULL), id`,
        [personIds]
      );
    },
    // Report photos still missing a thumbnail or the detection geometry. A row
    // whose face_detail holds only a crop (thumbnailed while Rekognition was
    // down) has no "box" yet, so it stays in this set until it gets one.
    // jsonb_exists, not the ? operator: node-pg reads ? as a placeholder.
    async photosMissingDerivatives(limit) {
      return all(
        `SELECT * FROM photos
         WHERE kind = 'report' AND octet_length(content) > 0
           AND (thumb IS NULL OR thumb_large IS NULL
                OR face_detail IS NULL OR NOT jsonb_exists(face_detail, 'box'))
         ORDER BY id LIMIT $1`,
        [limit]
      );
    },
    // Rescue photos are never kept: only the face signature survives.
    async clearPhotoContent(photoId) {
      await pool.query('UPDATE photos SET content = $1 WHERE id = $2', [Buffer.alloc(0), photoId]);
    },
    async photosByFaceIds(faceIds) {
      if (!faceIds.length) return [];
      return all(
        'SELECT id, person_id, kind, update_id, subscription_id, face_id FROM photos WHERE face_id = ANY($1)',
        [faceIds]
      );
    },
    async deletePerson(id) {
      return one('DELETE FROM people WHERE id = $1 RETURNING *', [id]);
    },
    // Two records turned out to be the same human: fold `fromId` into `toId`.
    // Nothing is discarded — every report, photo and alert is repointed first,
    // and only the emptied person row is deleted.
    async movePersonRecords(fromId, toId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('UPDATE updates SET person_id = $1 WHERE person_id = $2', [toId, fromId]);
        await client.query('UPDATE photos SET person_id = $1 WHERE person_id = $2', [toId, fromId]);
        // subscriptions has UNIQUE(person_id, channel, address): an address the
        // target already watches would collide, so it stays behind and is
        // removed by the cascade below — the target already alerts that person.
        await client.query(
          `UPDATE subscriptions s SET person_id = $1 WHERE s.person_id = $2
             AND NOT EXISTS (
               SELECT 1 FROM subscriptions t
               WHERE t.person_id = $1 AND t.channel = s.channel AND t.address = s.address
             )`,
          [toId, fromId]
        );
        await client.query('DELETE FROM people WHERE id = $1', [fromId]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    // The opposite move: pull ONE report (and its photos) off a person and onto
    // another. Undoes a name collision that filed two different humans as one.
    async moveUpdateToPerson(updateId, toPersonId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('UPDATE photos SET person_id = $1 WHERE update_id = $2', [toPersonId, updateId]);
        await client.query('UPDATE updates SET person_id = $1 WHERE id = $2', [toPersonId, updateId]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    async counts() {
      const r = await one(`SELECT
        (SELECT COUNT(*) FROM people)::int AS people,
        (SELECT COUNT(*) FROM updates)::int AS updates,
        (SELECT COUNT(*) FROM subscriptions)::int AS subscriptions,
        (SELECT COUNT(*) FROM subscriptions WHERE verified)::int AS subscriptions_verified,
        (SELECT COUNT(*) FROM photos)::int AS photos,
        (SELECT COUNT(*) FROM photos WHERE face_id IS NOT NULL)::int AS photos_indexed,
        (SELECT COUNT(*) FROM photos WHERE kind = 'report')::int AS photos_report,
        (SELECT COUNT(*) FROM photos WHERE kind = 'query')::int AS photos_query`);
      return r;
    },
    async photosMissingFaceId(limit) {
      return all('SELECT * FROM photos WHERE face_id IS NULL ORDER BY id LIMIT $1', [limit]);
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
