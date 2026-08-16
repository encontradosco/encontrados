// SQLite adapter — local development and tests. Zero setup, single file.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// #78: the public-registry sweep (source='aggregator') used to push a person
// already marked "Localizada" in the source as status='safe' here, even when
// nobody had ever reported them missing through this app. That row would then
// win "latest status" and count toward the public reunited counter — someone
// who never passed through encontrados.co, inflating a number families and
// rescuers read as this app's own signal.
//
// The feed no longer produces that row going forward (see toUpdate in
// src/sources/colombiatebusca.js), but rows synced before that fix already
// exist. Rather than delete history, "latest status" pretends they were never
// written: whatever real status came before resurfaces, and a person with no
// other update simply has none — neither missing nor reunited.
const AGGREGATOR_SAFE_EXCLUSION = `WHERE NOT (u.source = 'aggregator' AND u.status = 'safe')`;

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
      department TEXT,
      lat REAL,
      lng REAL,
      contact TEXT,
      source TEXT NOT NULL CHECK (source IN ('web','whatsapp','api','aggregator','rescate')),
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
      face_detail TEXT,
      thumb BLOB,
      thumb_type TEXT,
      thumb_large BLOB,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_photos_face ON photos(face_id);
    CREATE INDEX IF NOT EXISTS idx_photos_subscription ON photos(subscription_id);

    -- Bitácora de coincidencias y de envíos (#116, PR 3 — SOLO esquema; PR 4
    -- escribe en estas tablas). Mismas reglas que en Postgres (ver el
    -- comentario ahí): sin PII, retención heredada de ON DELETE CASCADE sobre
    -- people(id), created_at + índice para un cleanup job futuro.
    CREATE TABLE IF NOT EXISTS match_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      update_id INTEGER REFERENCES updates(id) ON DELETE CASCADE,
      face_id TEXT NOT NULL,
      similarity REAL,
      surface TEXT NOT NULL CHECK (surface IN ('rescate','report','api')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_match_log_person ON match_log(person_id);
    CREATE INDEX IF NOT EXISTS idx_match_log_created ON match_log(created_at);

    CREATE TABLE IF NOT EXISTS contact_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      update_id INTEGER REFERENCES updates(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel IN ('email','whatsapp','relevo')),
      result TEXT NOT NULL CHECK (result IN ('enviado','fallido','rechazado')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_contact_log_person ON contact_log(person_id);
    CREATE INDEX IF NOT EXISTS idx_contact_log_created ON contact_log(created_at);

    -- Bitácora de fusiones automáticas por nombre (#150, PR 2 — SOLO esquema
    -- acá; el write vive en people.js/findOrCreatePerson). Mismas reglas que
    -- las dos de arriba: sin PII, solo IDs/enums/números, ON DELETE CASCADE
    -- sobre people(id). person_id es el CANDIDATO evaluado (con quien se
    -- comparó), no necesariamente quien terminó dueño del update — por eso
    -- update_id es nullable: cuando la fusión se bloquea, el update nuevo
    -- termina en una persona DISTINTA, y esta fila igual queda como registro
    -- de que la comparación ocurrió y qué decidió.
    CREATE TABLE IF NOT EXISTS merge_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      update_id INTEGER REFERENCES updates(id) ON DELETE CASCADE,
      score REAL NOT NULL,
      department_match TEXT NOT NULL CHECK (department_match IN ('match','mismatch','unknown')),
      face_match TEXT NOT NULL CHECK (face_match IN ('match','mismatch','unknown')),
      blocked INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_merge_log_person ON merge_log(person_id);
    CREATE INDEX IF NOT EXISTS idx_merge_log_created ON merge_log(created_at);
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
  // De dónde salió la afirmación: el enlace a la noticia que confirma que una
  // persona apareció. Un `safe` con enlace carga su propia prueba; uno sin
  // enlace es una afirmación que nadie puede verificar.
  try {
    db.exec('ALTER TABLE updates ADD COLUMN source_url TEXT');
  } catch { /* already exists */ }
  // Departamento del lugar donde se cree que está la persona — de una lista
  // fija (src/departments.js), no texto libre. #150: es la señal que
  // findOrCreatePerson usa para no fusionar por nombre solo cuando dos
  // reportes apuntan a lugares muy distintos.
  try {
    db.exec('ALTER TABLE updates ADD COLUMN department TEXT');
  } catch { /* already exists */ }
  // Detection geometry (bounding box + landmarks) for the public overlay, and
  // the face thumbnail the public listing loads instead of the full photo.
  for (const col of ['face_detail TEXT', 'thumb BLOB', 'thumb_type TEXT', 'thumb_large BLOB']) {
    try {
      db.exec(`ALTER TABLE photos ADD COLUMN ${col}`);
    } catch { /* already exists */ }
  }
  // El reclamo de rescate NO es lo mismo que la propiedad del número, y venían
  // compartiendo el booleano `verified`. Una suscripción que el bot verificó
  // con SUSCRIBIR prueba que el número es de quien escribe; no dice nada sobre
  // si esa persona tiene a alguien al lado. Se separan:
  //   rescue_state      null | 'asked' | 'confirmed' | 'reported'
  //   rescue_similarity el % de la coincidencia que originó la pregunta, para
  //                     que el relevo no llegue sin el único dato que distingue
  //                     un rescate real de un parecido.
  // `rescue_asked_at` va como TEXTO ISO en los dos motores a propósito: la
  // ventana de 72 h se calcula en JS, y un TIMESTAMPTZ en Postgres volvería
  // como Date mientras SQLite devuelve string — dos formas del mismo dato es
  // exactamente la clase de diferencia que se cuela en producción y no en las
  // pruebas. `created_at` no sirve para esto: una fila de seguidor creada la
  // semana pasada puede recibir la pregunta hoy.
  for (const col of ['rescue_state TEXT', 'rescue_similarity REAL', 'rescue_asked_at TEXT']) {
    try {
      db.exec(`ALTER TABLE subscriptions ADD COLUMN ${col}`);
    } catch { /* already exists */ }
  }
  // Older dev databases: add external_id if missing. Note: SQLite can't widen
  // an existing CHECK constraint via ALTER TABLE, so a pre-existing local
  // ./data/encontrados.db still rejects source='aggregator' until it's recreated
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
    async allPeople(limit) {
      return db.prepare('SELECT id, full_name FROM people ORDER BY id LIMIT ?').all(limit);
    },
    async updatePersonName(id, fullName) {
      db.prepare('UPDATE people SET full_name = ? WHERE id = ?').run(fullName, id);
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
    async insertUpdate(personId, { status, message, location, department, lat, lng, source, sourceUrl, reporter, contact, externalId }) {
      const extId = externalId || null;
      const info = db
        .prepare(
          `INSERT INTO updates (person_id, status, message, location, department, lat, lng, source, source_url, reporter, contact, external_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE SET
             status = excluded.status,
             message = excluded.message,
             location = excluded.location,
             department = excluded.department,
             lat = excluded.lat,
             lng = excluded.lng,
             source_url = excluded.source_url,
             reporter = excluded.reporter,
             contact = excluded.contact`
        )
        .run(
          personId,
          status,
          message || null,
          location || null,
          department || null,
          Number.isFinite(lat) ? lat : null,
          Number.isFinite(lng) ? lng : null,
          source,
          sourceUrl || null,
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
    // "El estado actual de una persona es el de su update más reciente" (ver
    // POST /rescate/aviso en src/routes/web.js) es la regla que lee el bot de
    // WhatsApp, GET /api/people y las tarjetas de duplicados — no solo el
    // home. Sin el mismo filtro, esas tres superficies seguirían anunciando
    // "Localizada" por una fila del agregador que el home ya ignora.
    async latestUpdate(personId) {
      return db
        .prepare(
          `SELECT * FROM updates WHERE person_id = ? AND NOT (source = 'aggregator' AND status = 'safe')
           ORDER BY created_at DESC, id DESC LIMIT 1`
        )
        .get(personId);
    },
    // Everyone currently reported missing, most recent report first.
    // Everyone whose LATEST update is 'missing' — not everyone who was EVER
    // reported missing. Under the old "has ANY missing update" filter a person
    // later confirmed alive stayed on the list forever: their family sees them
    // still listed as missing, and rescuers keep looking for someone who is
    // already home.
    // The `reports` count this query used to return is gone: nothing rendered
    // it, and keeping it meant a second full GROUP BY over every update on the
    // busiest page of the site.
    async missingPeople(limit) {
      return db
        .prepare(
          `WITH latest AS (
             SELECT u.person_id, u.status, u.created_at,
                    ROW_NUMBER() OVER (PARTITION BY u.person_id ORDER BY u.created_at DESC, u.id DESC) AS rn
             FROM updates u
             ${AGGREGATOR_SAFE_EXCLUSION}
           )
           SELECT p.id, p.full_name, l.status, l.created_at AS last_report
           FROM people p
           JOIN latest l ON l.person_id = p.id AND l.rn = 1
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
             ${AGGREGATOR_SAFE_EXCLUSION}
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
    async subscriptionsForAddress(channel, address) {
      return db
        .prepare('SELECT * FROM subscriptions WHERE channel = ? AND address = ? ORDER BY id DESC')
        .all(channel, address);
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
    async setSubscriptionRescue(id, { state, similarity, askedAt } = {}) {
      db.prepare(
        `UPDATE subscriptions
            SET rescue_state = ?,
                rescue_similarity = COALESCE(?, rescue_similarity),
                rescue_asked_at = COALESCE(?, rescue_asked_at)
          WHERE id = ?`
      ).run(state || null, similarity == null ? null : Number(similarity), askedAt || null, id);
      return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
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
    async setPhotoFaceDetail(photoId, detail) {
      db.prepare('UPDATE photos SET face_detail = ? WHERE id = ?').run(
        detail ? JSON.stringify(detail) : null,
        photoId
      );
    },
    async setPhotoThumbnails(photoId, { small, large, contentType }) {
      db.prepare('UPDATE photos SET thumb = ?, thumb_large = ?, thumb_type = ? WHERE id = ?').run(
        small,
        large,
        contentType,
        photoId
      );
    },
    async getPhoto(id) {
      return db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
    },
    // Just enough to render a face plate. Deliberately NOT getPhoto: that one
    // does SELECT *, dragging the full image and both thumbnails out of the
    // database to read two columns.
    async reportPhotoMeta(id) {
      return db
        .prepare(
          "SELECT id, person_id, kind, content_type, face_id, face_detail, thumb_type FROM photos WHERE id = ? AND kind = 'report'"
        )
        .get(id);
    },
    // One photo per person for the public listing: the earliest report photo
    // that still has bytes and, preferably, a thumbnail to show.
    async reportPhotosForPeople(personIds) {
      if (!personIds.length) return [];
      const marks = personIds.map(() => '?').join(',');
      return db
        .prepare(
          `SELECT id, person_id, content_type, face_id, face_detail, thumb_type FROM photos
           WHERE kind = 'report' AND person_id IN (${marks}) AND length(content) > 0
           ORDER BY person_id, (thumb IS NULL), (thumb_large IS NULL), (face_detail IS NULL), id`
        )
        .all(...personIds);
    },
    // Report photos still missing a thumbnail or the detection geometry. A row
    // whose face_detail holds only a crop (thumbnailed while Rekognition was
    // down) has no "box" yet, so it stays in this set until it gets one — but
    // a row marked no_face is done: Rekognition already looked and found no
    // face, so retrying it every run would burn DetectFaces forever.
    async photosMissingDerivatives(limit) {
      return db
        .prepare(
          `SELECT * FROM photos
           WHERE kind = 'report' AND length(content) > 0
             AND (thumb IS NULL OR thumb_large IS NULL
                  OR face_detail IS NULL
                  OR (face_detail NOT LIKE '%"box"%' AND face_detail NOT LIKE '%"no_face"%'))
           ORDER BY id LIMIT ?`
        )
        .all(limit);
    },
    // Rescue photos are never kept: only the face signature survives.
    async clearPhotoContent(photoId) {
      db.prepare('UPDATE photos SET content = ? WHERE id = ?').run(Buffer.alloc(0), photoId);
    },
    // La misma foto exacta ya indexada para esta persona: su face_id, para
    // reusarlo en vez de sumar una firma nueva por la misma cara (#160 — un
    // reporte re-empujado con la misma foto multiplicaba firmas). face_id
    // IS NOT NULL ya excluye a la fila que se está procesando ahora mismo,
    // que todavía no tiene el suyo escrito.
    async photoFaceIdForContent(personId, kind, content) {
      const row = db
        .prepare(
          `SELECT face_id FROM photos
           WHERE person_id = ? AND kind = ? AND face_id IS NOT NULL AND content = ?
           LIMIT 1`
        )
        .get(personId, kind, content);
      return row ? row.face_id : null;
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
    // Metadatos de toda foto con firma facial — sin contenido ni derivados:
    // esto alimenta un conteo, no una pantalla.
    async indexedPhotos() {
      return db
        .prepare('SELECT id, person_id, kind, face_id FROM photos WHERE face_id IS NOT NULL ORDER BY id')
        .all();
    },
    // Las firmas faciales de las fotos de una persona. Hay que leerlas ANTES de
    // borrarla: la cascada se lleva las filas de `photos` y con ellas el único
    // registro de qué retirar de la colección de Rekognition.
    async faceIdsForPerson(personId) {
      return db
        .prepare('SELECT face_id FROM photos WHERE person_id = ? AND face_id IS NOT NULL')
        .all(personId)
        .map((r) => r.face_id);
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

    // Bitácora de coincidencias y de envíos (#116, PR 4 — la instrumentación;
    // las tablas las creó PR 3). Cada escritura la envuelve `src/logbook.js`
    // en un try/catch — acá abajo no hace falta duplicar esa protección.
    async insertMatchLog({ personId, updateId, faceId, similarity, surface }) {
      db.prepare(
        'INSERT INTO match_log (person_id, update_id, face_id, similarity, surface) VALUES (?, ?, ?, ?, ?)'
      ).run(personId, updateId ?? null, faceId, similarity ?? null, surface);
    },
    async insertContactLog({ personId, updateId, channel, result }) {
      db.prepare(
        'INSERT INTO contact_log (person_id, update_id, channel, result) VALUES (?, ?, ?, ?)'
      ).run(personId, updateId ?? null, channel, result);
    },
    async insertMergeLog({ personId, updateId, score, departmentMatch, faceMatch, blocked }) {
      db.prepare(
        'INSERT INTO merge_log (person_id, update_id, score, department_match, face_match, blocked) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(personId, updateId ?? null, score, departmentMatch, faceMatch, blocked ? 1 : 0);
    },
    // Cuántas fusiones se evaluaron y cuántas de esas se bloquearon — mismo
    // `since` opcional que matchLogCounts.
    async mergeLogCounts({ since } = {}) {
      const where = since ? 'WHERE created_at >= ?' : '';
      const params = since ? [since] : [];
      const total = db.prepare(`SELECT COUNT(*) AS n FROM merge_log ${where}`).get(...params).n;
      const blockedWhere = since ? 'WHERE created_at >= ? AND blocked = 1' : 'WHERE blocked = 1';
      const blocked = db.prepare(`SELECT COUNT(*) AS n FROM merge_log ${blockedWhere}`).get(...params).n;
      return { total, blocked };
    },
    // Cuenta total y por superficie. `since` (ISO) filtra a lo escrito desde
    // ahí — se usa para la línea de "cambio desde el reporte anterior" del
    // correo operativo; sin `since`, es el acumulado histórico completo.
    async matchLogCounts({ since } = {}) {
      const where = since ? 'WHERE created_at >= ?' : '';
      const params = since ? [since] : [];
      const total = db.prepare(`SELECT COUNT(*) AS n FROM match_log ${where}`).get(...params).n;
      const bySurface = {};
      for (const surface of ['rescate', 'report', 'api']) {
        const w = since ? 'WHERE created_at >= ? AND surface = ?' : 'WHERE surface = ?';
        const p = since ? [since, surface] : [surface];
        bySurface[surface] = db.prepare(`SELECT COUNT(*) AS n FROM match_log ${w}`).get(...p).n;
      }
      return { total, ...bySurface };
    },
    // Una fila por (channel, result) — el correo pivotea esto en su propia
    // tabla. `since` con el mismo significado que en matchLogCounts.
    async contactLogCounts({ since } = {}) {
      const where = since ? 'WHERE created_at >= ?' : '';
      const params = since ? [since] : [];
      return db
        .prepare(
          `SELECT channel, result, COUNT(*) AS count FROM contact_log ${where} GROUP BY channel, result ORDER BY channel, result`
        )
        .all(...params);
    },

    // Series por día (#116, PR 6 — el panel). `since` (ISO) siempre viene del
    // llamador ya calculado en JS — nunca aritmética de fechas en SQL — para
    // no depender de qué funciones de fecha trae la versión de SQLite en
    // este runtime. `date(created_at)` sí parsea bien el ISO con 'T'/'Z' que
    // ya usa el resto de este esquema.
    //
    // El corte de "día" es el de Bogotá, no UTC (hotfix): toda la superficie
    // (el pie del correo, el cron, el panel) habla en hora de Bogotá, y entre
    // las 19:00 y la medianoche Bogotá caía en el día SIGUIENTE bajo UTC —
    // cinco horas de cada día contadas en la fila equivocada. El modificador
    // '-5 hours' es el mismo desplazamiento fijo que usa el resto del repo
    // (Colombia no tiene horario de verano — ver report.js) y debe quedar
    // igual al `AT TIME ZONE 'America/Bogota'` del adapter de Postgres:
    // mismo corte de día en los dos motores.
    async matchLogDaily({ since } = {}) {
      const where = since ? 'WHERE created_at >= ?' : '';
      const params = since ? [since] : [];
      return db
        .prepare(
          `SELECT date(created_at, '-5 hours') AS day, COUNT(*) AS count FROM match_log ${where} GROUP BY day ORDER BY day`
        )
        .all(...params);
    },
    async contactLogDaily({ since } = {}) {
      const where = since ? 'WHERE created_at >= ?' : '';
      const params = since ? [since] : [];
      return db
        .prepare(
          `SELECT date(created_at, '-5 hours') AS day, result, COUNT(*) AS count FROM contact_log ${where} GROUP BY day, result ORDER BY day`
        )
        .all(...params);
    },

    // El primer registro de cada tabla (hotfix post-#127/#128 — "los ceros
    // pre-instrumentación son una mentira por omisión"). Antes de esta fecha
    // la bitácora no existía: no es que no pasó nada, es que no se medía.
    // null si la tabla está vacía — todavía no hay ningún registro.
    async matchLogEarliest() {
      const r = db.prepare('SELECT MIN(created_at) AS min FROM match_log').get();
      return r.min || null;
    },
    async contactLogEarliest() {
      const r = db.prepare('SELECT MIN(created_at) AS min FROM contact_log').get();
      return r.min || null;
    },

    // Cifras del panel #132 — mismo contrato que el adapter de Postgres (ver
    // ahí el porqué de cada una).
    async updatesBeyondFirstBySource() {
      return db
        .prepare(
          `WITH ranked AS (
             SELECT source, ROW_NUMBER() OVER (PARTITION BY person_id ORDER BY created_at ASC, id ASC) AS rn
             FROM updates
           )
           SELECT source, COUNT(*) AS n FROM ranked WHERE rn > 1 GROUP BY source`
        )
        .all();
    },
    // `subscription_id` es nuevo (#132, punto 5) — mismo contrato que el
    // adapter de Postgres (ver ahí el porqué del GROUP BY en vez de DISTINCT).
    async queryPhotoPeople() {
      return db
        .prepare(
          `SELECT ph.person_id AS person_id, p.normalized_name AS normalized_name, MAX(ph.subscription_id) AS subscription_id
           FROM photos ph JOIN people p ON p.id = ph.person_id
           WHERE ph.kind = 'query'
           GROUP BY ph.person_id, p.normalized_name`
        )
        .all();
    },
    async matchLogSimilarityRows() {
      return db.prepare('SELECT similarity, surface FROM match_log').all();
    },

    async close() {
      db.close();
    }
  };
}

module.exports = { createSqliteAdapter };
