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
      source TEXT NOT NULL CHECK (source IN ('web','whatsapp','api','aggregator','rescate')),
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

    -- Bitácora de coincidencias y de envíos (#116, PR 3 — SOLO esquema; PR 4
    -- escribe en estas tablas). El diseño aprobado es explícito: "sin
    -- teléfonos, sin correos, sin nombres" — cada columna es un ID, un enum o
    -- un número. Un person_id sigue siendo dato vinculable a una persona
    -- (habeas data, Ley 1581), así que ambas heredan la MISMA retención que ya
    -- rige el resto del esquema: ON DELETE CASCADE sobre people(id). Hoy esa
    -- retención es a demanda (DELETE /api/people/:id, la solicitud de borrado
    -- de la política de privacidad) — no existe un TTL automático por edad en
    -- ningún lado de este esquema, y estas tablas no inventan uno. created_at
    -- + su índice quedan listos para que un cleanup job futuro (PR 4 o
    -- posterior) pueda purgar por antigüedad si hace falta.
    CREATE TABLE IF NOT EXISTS match_log (
      id SERIAL PRIMARY KEY,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      update_id INTEGER REFERENCES updates(id) ON DELETE CASCADE,
      face_id TEXT NOT NULL,
      similarity DOUBLE PRECISION,
      surface TEXT NOT NULL CHECK (surface IN ('rescate','report','api')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_match_log_person ON match_log(person_id);
    CREATE INDEX IF NOT EXISTS idx_match_log_created ON match_log(created_at);

    CREATE TABLE IF NOT EXISTS contact_log (
      id SERIAL PRIMARY KEY,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      update_id INTEGER REFERENCES updates(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel IN ('email','whatsapp','relevo')),
      result TEXT NOT NULL CHECK (result IN ('enviado','fallido','rechazado')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_contact_log_person ON contact_log(person_id);
    CREATE INDEX IF NOT EXISTS idx_contact_log_created ON contact_log(created_at);
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

  // El reclamo de rescate NO es lo mismo que la propiedad del número, y venían
  // compartiendo el booleano `verified`. Una suscripción que el bot verificó
  // con SUSCRIBIR prueba que el número es de quien escribe; no dice nada sobre
  // si esa persona tiene a alguien al lado. Se separan:
  //   rescue_state      null | 'asked' | 'confirmed' | 'reported'
  //   rescue_similarity el % de la coincidencia que originó la pregunta, para
  //                     que el relevo no llegue sin el único dato que distingue
  //                     un rescate real de un parecido.
  await pool.query('ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS rescue_state TEXT');
  await pool.query('ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS rescue_similarity DOUBLE PRECISION');
  // TEXTO ISO a propósito, igual que en SQLite: la ventana de 72 h se calcula
  // en JS y un TIMESTAMPTZ volvería como Date acá y como string allá — dos
  // formas del mismo dato es lo que se cuela en producción y no en las pruebas.
  // `created_at` no sirve: una fila de seguidor creada la semana pasada puede
  // recibir la pregunta hoy.
  await pool.query('ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS rescue_asked_at TEXT');

  // Integration seam for an external aggregator: external_id lets a caller
  // re-POST the same update idempotently (see insertUpdate below), and
  // 'aggregator' is a real source distinct from the app's own web/whatsapp/api.
  await pool.query('ALTER TABLE updates ADD COLUMN IF NOT EXISTS external_id TEXT');
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_updates_external_id
      ON updates(external_id) WHERE external_id IS NOT NULL
  `);
  // Widen the source CHECK for DBs created before 'aggregator' (and later
  // 'rescate', a rescuer's aviso via POST /rescate/aviso) existed.
  // Cheap on this table's scale; matches the ADD COLUMN IF NOT EXISTS pattern above.
  //
  // DROP y ADD van en un SOLO `ALTER TABLE`: Postgres corre el statement en una
  // transacción implícita y toma el lock de la tabla una vez, así que dos
  // instancias arrancando a la vez se serializan. Separados en dos statements
  // se intercalan (A dropea, B dropea, A agrega, B agrega → 42710) y el
  // arranque muere. Postgres procesa el DROP antes que el ADD dentro del mismo
  // ALTER, así que el orden está garantizado.
  await pool.query(`
    ALTER TABLE updates
      DROP CONSTRAINT IF EXISTS updates_source_check,
      ADD  CONSTRAINT updates_source_check
        CHECK (source IN ('web','whatsapp','api','aggregator','rescate'))
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
    // Everyone whose LATEST update is 'missing' — not everyone who was EVER
    // reported missing. Under the old "has ANY missing update" filter a person
    // later confirmed alive stayed on the list forever: their family sees them
    // still listed as missing, and rescuers keep looking for someone who is
    // already home.
    // The `reports` count this query used to return is gone: nothing rendered
    // it, and keeping it meant a second full GROUP BY over every update on the
    // busiest page of the site.
    async missingPeople(limit) {
      return all(
        `WITH latest AS (
           SELECT u.person_id, u.status, u.created_at,
                  ROW_NUMBER() OVER (PARTITION BY u.person_id ORDER BY u.created_at DESC, u.id DESC) AS rn
           FROM updates u
         )
         SELECT p.id, p.full_name, l.status, l.created_at AS last_report
         FROM people p
         JOIN latest l ON l.person_id = p.id AND l.rn = 1
         WHERE l.status = 'missing'
         ORDER BY l.created_at DESC
         LIMIT $1`,
        [limit]
      );
    },
    // How many people whose LATEST status is 'safe' — the reunited counter.
    // Same "latest status per person" logic as missingPeople above.
    async reunitedCount() {
      const r = await one(
        `WITH latest AS (
           SELECT u.person_id, u.status,
                  ROW_NUMBER() OVER (PARTITION BY u.person_id ORDER BY u.created_at DESC, u.id DESC) AS rn
           FROM updates u
         )
         SELECT COUNT(*)::int AS n FROM latest WHERE rn = 1 AND status = 'safe'`
      );
      return r.n;
    },
    async recentUpdates(limit) {
      return all(
        `SELECT u.*, p.full_name FROM updates u JOIN people p ON p.id = u.person_id
         ORDER BY u.created_at DESC, u.id DESC LIMIT $1`,
        [limit]
      );
    },
    async subscriptionsForAddress(channel, address) {
      return all('SELECT * FROM subscriptions WHERE channel = $1 AND address = $2 ORDER BY id DESC', [
        channel,
        address
      ]);
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
    async setSubscriptionRescue(id, { state, similarity, askedAt } = {}) {
      return one(
        `UPDATE subscriptions
            SET rescue_state = $2,
                rescue_similarity = COALESCE($3, rescue_similarity),
                rescue_asked_at = COALESCE($4, rescue_asked_at)
          WHERE id = $1
          RETURNING *`,
        [id, state || null, similarity == null ? null : Number(similarity), askedAt || null]
      );
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
    // Just enough to render a face plate. Deliberately NOT getPhoto: that one
    // does SELECT *, dragging the full image and both thumbnails out of the
    // database to read two columns.
    async reportPhotoMeta(id) {
      return one(
        `SELECT id, person_id, kind, content_type, face_id, face_detail, thumb_type
         FROM photos WHERE id = $1 AND kind = 'report'`,
        [id]
      );
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
    // down) has no "box" yet, so it stays in this set until it gets one — but
    // a row marked no_face is done: Rekognition already looked and found no
    // face, so retrying it every run would burn DetectFaces forever.
    // jsonb_exists, not the ? operator: node-pg reads ? as a placeholder.
    async photosMissingDerivatives(limit) {
      return all(
        `SELECT * FROM photos
         WHERE kind = 'report' AND octet_length(content) > 0
           AND (thumb IS NULL OR thumb_large IS NULL
                OR face_detail IS NULL
                OR NOT (jsonb_exists(face_detail, 'box') OR jsonb_exists(face_detail, 'no_face')))
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
    // Metadatos de toda foto con firma facial — sin contenido ni derivados:
    // esto alimenta un conteo, no una pantalla.
    async indexedPhotos() {
      return all(
        'SELECT id, person_id, kind, face_id FROM photos WHERE face_id IS NOT NULL ORDER BY id',
        []
      );
    },
    // Las firmas faciales de las fotos de una persona. Hay que leerlas ANTES de
    // borrarla: la cascada se lleva las filas de `photos` y con ellas el único
    // registro de qué retirar de la colección de Rekognition.
    async faceIdsForPerson(personId) {
      const rows = await all(
        'SELECT face_id FROM photos WHERE person_id = $1 AND face_id IS NOT NULL',
        [personId]
      );
      return rows.map((r) => r.face_id);
    },
    async deletePerson(id) {
      return one('DELETE FROM people WHERE id = $1 RETURNING *', [id]);
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

    // Bitácora de coincidencias y de envíos (#116, PR 4 — la instrumentación;
    // las tablas las creó PR 3). Cada escritura la envuelve `src/logbook.js`
    // en un try/catch — acá abajo no hace falta duplicar esa protección.
    async insertMatchLog({ personId, updateId, faceId, similarity, surface }) {
      await pool.query(
        'INSERT INTO match_log (person_id, update_id, face_id, similarity, surface) VALUES ($1, $2, $3, $4, $5)',
        [personId, updateId ?? null, faceId, similarity ?? null, surface]
      );
    },
    async insertContactLog({ personId, updateId, channel, result }) {
      await pool.query(
        'INSERT INTO contact_log (person_id, update_id, channel, result) VALUES ($1, $2, $3, $4)',
        [personId, updateId ?? null, channel, result]
      );
    },
    // Cuenta total y por superficie. `since` (ISO) filtra a lo escrito desde
    // ahí — se usa para la línea de "cambio desde el reporte anterior" del
    // correo operativo; sin `since`, es el acumulado histórico completo.
    async matchLogCounts({ since } = {}) {
      const clause = since ? 'WHERE created_at >= $1' : '';
      const totalParams = since ? [since] : [];
      const total = (await one(`SELECT COUNT(*)::int AS n FROM match_log ${clause}`, totalParams)).n;
      const bySurface = {};
      for (const surface of ['rescate', 'report', 'api']) {
        const w = since ? 'WHERE created_at >= $1 AND surface = $2' : 'WHERE surface = $1';
        const p = since ? [since, surface] : [surface];
        bySurface[surface] = (await one(`SELECT COUNT(*)::int AS n FROM match_log ${w}`, p)).n;
      }
      return { total, ...bySurface };
    },
    // Una fila por (channel, result) — el correo pivotea esto en su propia
    // tabla. `since` con el mismo significado que en matchLogCounts.
    async contactLogCounts({ since } = {}) {
      const clause = since ? 'WHERE created_at >= $1' : '';
      const params = since ? [since] : [];
      return all(
        `SELECT channel, result, COUNT(*)::int AS count FROM contact_log ${clause} GROUP BY channel, result ORDER BY channel, result`,
        params
      );
    },

    async close() {
      await pool.end();
    }
  };
}

module.exports = { createPostgresAdapter };
