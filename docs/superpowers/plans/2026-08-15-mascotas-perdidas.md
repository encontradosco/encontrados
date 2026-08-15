# Mascotas perdidas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dejar que quien encontró una mascota compare su foto contra las
fotos de mascotas reportadas como perdidas, y viceversa, usando un modelo de
embeddings propio (no Rekognition, que no reconoce animales).

**Architecture:** Dos tablas nuevas (`pets`, `pet_photos`, `pet_subscriptions`)
en los dos adaptadores existentes, un módulo Python auto-hospedado
(`pet-matcher/`) que calcula un embedding por foto, y un módulo Node
(`src/petfaces.js` + `src/petmatch.js`) que espeja `src/faces.js` +
`src/facematch.js` pero comparando embeddings en JS en vez de usar la
colección administrada de Rekognition.

**Tech Stack:** Node 22 + Express 4 + better-sqlite3/pg (igual que el resto
del repo). Python 3.11+ + Flask + `transformers`/`torch` para el servicio de
embeddings, aislado en su propia carpeta.

**Spec:** `docs/superpowers/specs/2026-08-15-mascotas-perdidas-design.md`

## Ajustes sobre el diseño (encontrados al planear, no al construir)

Dos afinamientos sobre lo que dice el spec, ambos dentro de su espíritu —
se anotan acá para que quien revise no los lea como una desviación oculta:

1. **`species` vive también en `pet_photos`, no solo en `pets`.** Una foto de
   tipo `query` (alguien que encontró una mascota) no tiene `pet_id` — no hay
   identidad conocida a la que colgarla — así que no hay de dónde sacar la
   especie por join. Se pide directo en el formulario de "encontré" y se
   guarda en la foto.
2. **`pet_subscriptions` se crea (como dice el spec) pero no se usa todavía.**
   El spec ya declaraba que "avisar a quien encontró después" queda fuera de
   esta versión. Como consecuencia, la ruta `/mascotas/encontre` no le pide
   contacto a nadie y `notify.js`/el modo `relay` no se tocan en este plan —
   no hay ninguna dirección a la que avisar todavía. El contacto de quien
   reporta una mascota perdida sí se muestra en pantalla, directo, a quien la
   encontró — igual que ya hace `/rescate` con el contacto de una familia.

## Global Constraints

- Todo el texto de cara al usuario, en español (`CLAUDE.md`).
- Ningún dato de contacto (`pets.contact`) sale en una respuesta pública sin
  que medie una coincidencia — mismo principio que `contact` en `updates`.
- Ninguna variable de entorno nueva es obligatoria: sin `PET_MATCH_API_URL`
  el matching de mascotas se apaga solo, las fotos se guardan igual.
- Una tabla o columna nueva se agrega en **los dos** adaptadores
  (`src/store/postgres.js` y `src/store/sqlite.js`) en el mismo commit.
- `npm test` en verde antes de cada commit que toque código Node.
- Nunca nombres/datos de personas reales — sintéticos siempre, en tests y
  fixtures.
- Esta rama **no se mergea a `main` sin que una persona lo decida** (regla 3
  de `CLAUDE.md`: toca esquema y comportamiento de usuario). Nada de push a
  remoto ni PR hasta que el usuario lo autorice.

---

## File Structure

| Archivo | Responsabilidad |
|---|---|
| `src/upload.js` (nuevo) | Config de `multer` compartida — se extrae de `src/routes/web.js` para no duplicarla en `src/routes/pets.js`. |
| `src/store/sqlite.js` (modificado) | Tablas `pets`/`pet_photos`/`pet_subscriptions` + sus métodos CRUD. |
| `src/store/postgres.js` (modificado) | Mismas tablas y métodos, dialecto Postgres. |
| `src/pets.js` (nuevo) | Capa de dominio para mascotas — espejo liviano de `src/people.js`, sin nada de búsqueda por nombre ni rescue-state. |
| `pet-matcher/` (nuevo, Python) | Servicio de embeddings, aislado, sin autenticación por ahora. |
| `src/petfaces.js` (nuevo) | Cliente HTTP hacia `pet-matcher/` — mismo contrato de degradación que `src/faces.js`. |
| `src/petmatch.js` (nuevo) | Orquestación: guardar foto, pedir embedding, comparar, miniatura — espejo de `src/facematch.js`. |
| `src/routes/pets.js` (nuevo) | Páginas: landing, reporte, "encontré", ficha, fotos, marcar encontrada. |
| `src/server.js` (modificado) | Monta el router nuevo. |
| `src/routes/api.js` (modificado) | `/api/diag` gana el bloque `pet_matching`; `/api/reindex` también recoge fotos de mascotas pendientes. |
| `src/html.js` (modificado) | Un link más en el nav. |
| `test/helpers.js` (modificado) | `fakePetMatcher()` — doble HTTP local, mismo patrón que `fakeSendgrid`/`fakeGithub`. |
| `test/pets-schema.test.js` (nuevo) | Pruebas del esquema y de la capa de dominio `src/pets.js`. |
| `test/petfaces.test.js` (nuevo) | Pruebas del cliente HTTP hacia `pet-matcher/`. |
| `test/petmatch.test.js` (nuevo) | Pruebas de la orquestación (comparar, filtrar por especie, backfill). |
| `test/pets.test.js` (nuevo) | Prueba end-to-end del flujo completo por HTTP. |
| `.env.example` (modificado) | `PET_MATCH_API_URL`, `PET_MATCH_THRESHOLD`. |
| `agent.md` (modificado) | Entrada en la tabla de variables de entorno. |

---

### Task 1: Extraer la configuración de `multer` a `src/upload.js`

Refactor mecánico, sin cambio de comportamiento — se hace primero porque la
ruta de "reporta mascota perdida" (Task 8) necesita la misma config y
duplicarla sería el primer DRY roto del feature.

**Files:**
- Create: `src/upload.js`
- Modify: `src/routes/web.js` (líneas 3, 35-49 según la lectura actual)
- Test: `test/app.test.js` (ya existe — no se agrega ninguno nuevo; este task se valida con la suite completa)

**Interfaces:**
- Produces: `const { upload } = require('../upload')` — mismo objeto
  `multer` que ya se usaba, mismo comportamiento exacto.

- [ ] **Step 1: Confirmar que la suite está en verde antes de tocar nada**

Run: `npm test`
Expected: PASS (0 fallos) — es la línea base contra la que se compara después del refactor.

- [ ] **Step 2: Crear `src/upload.js`**

```js
// Config de multer compartida entre /report, /rescate (src/routes/web.js) y
// las rutas de mascotas (src/routes/pets.js). Un solo lugar para el límite de
// tamaño y el filtro de tipo — dos copias del mismo filtro es el primer sitio
// donde una se actualiza y la otra no.
const multer = require('multer');

// Un navegador no etiqueta con certeza lo que sube: una foto elegida en Files,
// recibida por WhatsApp o arrastrada desde escritorio llega seguido como
// application/octet-stream. Filtrar solo por esa etiqueta la descarta SIN
// error, y quien reporta ve "sube una foto" habiendo subido una. El veredicto
// real se deja a los bytes (src/photo.js); acá el filtro es solo una primera
// pasada barata.
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?)$/i;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 8 },
  fileFilter: (req, file, cb) => {
    const type = (file.mimetype || '').toLowerCase();
    cb(
      null,
      type.startsWith('image/') ||
        type === 'application/octet-stream' ||
        IMAGE_EXT.test(file.originalname || '')
    );
  }
});

module.exports = { upload, IMAGE_EXT };
```

- [ ] **Step 3: Reemplazar la definición local en `src/routes/web.js`**

Quitar el bloque `const IMAGE_EXT = ...` y `const upload = multer({...})`
(las líneas que hoy definen ambos), y en su lugar, junto a los demás
`require` del principio del archivo:

```js
const { upload } = require('../upload');
```

- [ ] **Step 4: Confirmar que nada cambió de comportamiento**

Run: `npm test`
Expected: PASS, exactamente los mismos resultados que en el Step 1 — este
refactor no debía cambiar ni una sola aserción.

- [ ] **Step 5: Commit**

```bash
git add src/upload.js src/routes/web.js
git commit -m "Extrae la configuración de subida de fotos a su propio archivo, para reusarla en mascotas"
```

---

### Task 2: Esquema — tablas `pets`, `pet_photos`, `pet_subscriptions`

**Files:**
- Modify: `src/store/sqlite.js`
- Modify: `src/store/postgres.js`
- Test: `test/pets-schema.test.js` (nuevo)

**Interfaces:**
- Produces (en AMBOS adaptadores, mismo contrato):
  - `insertPet({ species, petName, description, contact }) → row`
  - `getPet(id) → row | undefined`
  - `markPetResolved(id) → row`
  - `insertPetPhoto({ petId, kind, species, subscriptionId, content, contentType }) → { id, pet_id, kind, species, content_type, created_at }`
  - `getPetPhoto(id) → row completa | undefined`
  - `setPetPhotoEmbedding(photoId, embedding, model) → void`
  - `setPetPhotoThumbnail(photoId, { small, contentType }) → void`
  - `clearPetPhotoContent(photoId) → void`
  - `petPhotosForMatching(kind, species) → [{ id, pet_id, embedding }]` (solo filas con embedding)
  - `petPhotosMissingEmbedding(limit) → [row completa]`
  - `petPhotosForPet(petId) → [{ id, pet_id, content_type, thumb_type }]` (solo `kind='report'`)

- [ ] **Step 1: Escribir la prueba de esquema (falla: nada de esto existe todavía)**

Crear `test/pets-schema.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { createSqliteAdapter } = require('../src/store/sqlite');

async function freshAdapter() {
  return createSqliteAdapter(':memory:');
}

test('insertPet guarda y getPet lee de vuelta', async () => {
  const adapter = await freshAdapter();
  const pet = await adapter.insertPet({
    species: 'dog',
    petName: 'Toby',
    description: 'Mediano, negro, collar rojo',
    contact: '300 111 2222'
  });
  assert.equal(pet.species, 'dog');
  assert.equal(pet.pet_name, 'Toby');
  const back = await adapter.getPet(pet.id);
  assert.equal(back.contact, '300 111 2222');
  assert.equal(back.resolved_at, null);
});

test('markPetResolved pone resolved_at', async () => {
  const adapter = await freshAdapter();
  const pet = await adapter.insertPet({ species: 'cat', description: null, contact: 'a@ejemplo.com' });
  const resolved = await adapter.markPetResolved(pet.id);
  assert.ok(resolved.resolved_at, 'debe quedar una fecha');
});

test('una foto report necesita pet_id; una query no', async () => {
  const adapter = await freshAdapter();
  const pet = await adapter.insertPet({ species: 'dog', description: null, contact: '300 000 0000' });
  const report = await adapter.insertPetPhoto({
    petId: pet.id,
    kind: 'report',
    species: 'dog',
    content: Buffer.from('foto'),
    contentType: 'image/jpeg'
  });
  assert.equal(report.pet_id, pet.id);

  const query = await adapter.insertPetPhoto({
    petId: null,
    kind: 'query',
    species: 'dog',
    content: Buffer.from('foto2'),
    contentType: 'image/jpeg'
  });
  assert.equal(query.pet_id, null);

  // Una fila 'report' sin pet_id la rechaza el CHECK del esquema.
  await assert.rejects(() =>
    adapter.insertPetPhoto({ petId: null, kind: 'report', species: 'dog', content: Buffer.from('x'), contentType: 'image/jpeg' })
  );
});

test('setPetPhotoEmbedding + petPhotosForMatching filtran por kind y especie', async () => {
  const adapter = await freshAdapter();
  const pet = await adapter.insertPet({ species: 'dog', description: null, contact: '300 000 0000' });
  const report = await adapter.insertPetPhoto({
    petId: pet.id, kind: 'report', species: 'dog', content: Buffer.from('f'), contentType: 'image/jpeg'
  });
  await adapter.setPetPhotoEmbedding(report.id, [0.1, 0.2, 0.3], 'modelo-test');

  const gatoReport = await adapter.insertPet({ species: 'cat', description: null, contact: 'x@ejemplo.com' });
  const gatoPhoto = await adapter.insertPetPhoto({
    petId: gatoReport.id, kind: 'report', species: 'cat', content: Buffer.from('g'), contentType: 'image/jpeg'
  });
  await adapter.setPetPhotoEmbedding(gatoPhoto.id, [0.9, 0.9, 0.9], 'modelo-test');

  const dogs = await adapter.petPhotosForMatching('report', 'dog');
  assert.equal(dogs.length, 1);
  assert.equal(dogs[0].pet_id, pet.id);

  const cats = await adapter.petPhotosForMatching('report', 'cat');
  assert.equal(cats.length, 1);

  // Sin embedding todavía: no debe aparecer como candidata.
  const sinEmbedding = await adapter.insertPetPhoto({
    petId: pet.id, kind: 'report', species: 'dog', content: Buffer.from('h'), contentType: 'image/jpeg'
  });
  const stillOne = await adapter.petPhotosForMatching('report', 'dog');
  assert.equal(stillOne.length, 1, 'la foto sin embedding no debe salir como candidata');
  assert.equal((await adapter.petPhotosMissingEmbedding(50)).some((p) => p.id === sinEmbedding.id), true);
});

test('clearPetPhotoContent vacía el contenido sin borrar la fila', async () => {
  const adapter = await freshAdapter();
  const photo = await adapter.insertPetPhoto({
    petId: null, kind: 'query', species: 'cat', content: Buffer.from('foto'), contentType: 'image/jpeg'
  });
  await adapter.clearPetPhotoContent(photo.id);
  const back = await adapter.getPetPhoto(photo.id);
  assert.equal(back.content.length, 0);
});

test('setPetPhotoThumbnail y petPhotosForPet', async () => {
  const adapter = await freshAdapter();
  const pet = await adapter.insertPet({ species: 'dog', description: null, contact: '300 000 0000' });
  const photo = await adapter.insertPetPhoto({
    petId: pet.id, kind: 'report', species: 'dog', content: Buffer.from('foto'), contentType: 'image/jpeg'
  });
  await adapter.setPetPhotoThumbnail(photo.id, { small: Buffer.from('mini'), contentType: 'image/jpeg' });
  const forPet = await adapter.petPhotosForPet(pet.id);
  assert.equal(forPet.length, 1);
  assert.equal(forPet[0].thumb_type, 'image/jpeg');
});
```

- [ ] **Step 2: Correr la prueba, confirmar que falla**

Run: `npx node --test test/pets-schema.test.js`
Expected: FAIL — `adapter.insertPet is not a function` (o similar), porque nada de esto existe todavía.

- [ ] **Step 3: Agregar las tablas a `src/store/sqlite.js`**

Dentro del mismo `db.exec(...)` que ya crea `people`/`updates`/`photos`/etc.
(inmediatamente después del bloque de `contact_log`), agregar:

```sql
    CREATE TABLE IF NOT EXISTS pets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      species TEXT NOT NULL CHECK (species IN ('dog','cat')),
      pet_name TEXT,
      description TEXT,
      contact TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE TABLE IF NOT EXISTS pet_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL CHECK (channel IN ('email','whatsapp')),
      address TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0,
      verify_token TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE TABLE IF NOT EXISTS pet_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pet_id INTEGER REFERENCES pets(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('report','query')),
      species TEXT NOT NULL CHECK (species IN ('dog','cat')),
      subscription_id INTEGER REFERENCES pet_subscriptions(id) ON DELETE CASCADE,
      content BLOB NOT NULL,
      content_type TEXT NOT NULL,
      embedding TEXT,
      embedding_model TEXT,
      thumb BLOB,
      thumb_type TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      CHECK (kind <> 'report' OR pet_id IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_pet_photos_pet ON pet_photos(pet_id);
    CREATE INDEX IF NOT EXISTS idx_pet_photos_kind_species ON pet_photos(kind, species);
```

Y, en el `return { ... }` del adaptador, junto a los métodos de `photos`:

```js
    async insertPet({ species, petName, description, contact }) {
      const info = db
        .prepare('INSERT INTO pets (species, pet_name, description, contact) VALUES (?, ?, ?, ?)')
        .run(species, petName || null, description || null, contact || null);
      return db.prepare('SELECT * FROM pets WHERE id = ?').get(info.lastInsertRowid);
    },
    async getPet(id) {
      return db.prepare('SELECT * FROM pets WHERE id = ?').get(id);
    },
    async markPetResolved(id) {
      db.prepare("UPDATE pets SET resolved_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(id);
      return db.prepare('SELECT * FROM pets WHERE id = ?').get(id);
    },
    async insertPetPhoto({ petId, kind, species, subscriptionId, content, contentType }) {
      const info = db
        .prepare(
          'INSERT INTO pet_photos (pet_id, kind, species, subscription_id, content, content_type) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(petId || null, kind, species, subscriptionId || null, content, contentType);
      return db
        .prepare('SELECT id, pet_id, kind, species, content_type, created_at FROM pet_photos WHERE id = ?')
        .get(info.lastInsertRowid);
    },
    async getPetPhoto(id) {
      return db.prepare('SELECT * FROM pet_photos WHERE id = ?').get(id);
    },
    async setPetPhotoEmbedding(photoId, embedding, model) {
      db.prepare('UPDATE pet_photos SET embedding = ?, embedding_model = ? WHERE id = ?').run(
        JSON.stringify(embedding),
        model || null,
        photoId
      );
    },
    async setPetPhotoThumbnail(photoId, { small, contentType }) {
      db.prepare('UPDATE pet_photos SET thumb = ?, thumb_type = ? WHERE id = ?').run(small, contentType, photoId);
    },
    async clearPetPhotoContent(photoId) {
      db.prepare('UPDATE pet_photos SET content = ? WHERE id = ?').run(Buffer.alloc(0), photoId);
    },
    async petPhotosForMatching(kind, species) {
      return db
        .prepare(
          'SELECT id, pet_id, embedding FROM pet_photos WHERE kind = ? AND species = ? AND embedding IS NOT NULL'
        )
        .all(kind, species);
    },
    async petPhotosMissingEmbedding(limit) {
      return db.prepare('SELECT * FROM pet_photos WHERE embedding IS NULL ORDER BY id LIMIT ?').all(limit);
    },
    async petPhotosForPet(petId) {
      return db
        .prepare(
          "SELECT id, pet_id, content_type, thumb_type FROM pet_photos WHERE kind = 'report' AND pet_id = ? ORDER BY id"
        )
        .all(petId);
    },
```

- [ ] **Step 4: Correr la prueba, confirmar que pasa**

Run: `npx node --test test/pets-schema.test.js`
Expected: PASS, las 6 pruebas en verde.

- [ ] **Step 5: Repetir el mismo esquema y los mismos métodos en `src/store/postgres.js`**

En el mismo bloque `await pool.query(...)` que crea `people`/`updates`/etc.:

```sql
    CREATE TABLE IF NOT EXISTS pets (
      id SERIAL PRIMARY KEY,
      species TEXT NOT NULL CHECK (species IN ('dog','cat')),
      pet_name TEXT,
      description TEXT,
      contact TEXT,
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS pet_subscriptions (
      id SERIAL PRIMARY KEY,
      channel TEXT NOT NULL CHECK (channel IN ('email','whatsapp')),
      address TEXT NOT NULL,
      verified BOOLEAN NOT NULL DEFAULT false,
      verify_token TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS pet_photos (
      id SERIAL PRIMARY KEY,
      pet_id INTEGER REFERENCES pets(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('report','query')),
      species TEXT NOT NULL CHECK (species IN ('dog','cat')),
      subscription_id INTEGER REFERENCES pet_subscriptions(id) ON DELETE CASCADE,
      content BYTEA NOT NULL,
      content_type TEXT NOT NULL,
      embedding JSONB,
      embedding_model TEXT,
      thumb BYTEA,
      thumb_type TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (kind <> 'report' OR pet_id IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_pet_photos_pet ON pet_photos(pet_id);
    CREATE INDEX IF NOT EXISTS idx_pet_photos_kind_species ON pet_photos(kind, species);
```

Y los métodos (con el mismo helper `one`/`all` que ya usa el archivo):

```js
    async insertPet({ species, petName, description, contact }) {
      return one(
        'INSERT INTO pets (species, pet_name, description, contact) VALUES ($1, $2, $3, $4) RETURNING *',
        [species, petName || null, description || null, contact || null]
      );
    },
    async getPet(id) {
      return one('SELECT * FROM pets WHERE id = $1', [id]);
    },
    async markPetResolved(id) {
      return one('UPDATE pets SET resolved_at = now() WHERE id = $1 RETURNING *', [id]);
    },
    async insertPetPhoto({ petId, kind, species, subscriptionId, content, contentType }) {
      return one(
        `INSERT INTO pet_photos (pet_id, kind, species, subscription_id, content, content_type)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, pet_id, kind, species, content_type, created_at`,
        [petId || null, kind, species, subscriptionId || null, content, contentType]
      );
    },
    async getPetPhoto(id) {
      return one('SELECT * FROM pet_photos WHERE id = $1', [id]);
    },
    async setPetPhotoEmbedding(photoId, embedding, model) {
      await pool.query('UPDATE pet_photos SET embedding = $1, embedding_model = $2 WHERE id = $3', [
        JSON.stringify(embedding),
        model || null,
        photoId
      ]);
    },
    async setPetPhotoThumbnail(photoId, { small, contentType }) {
      await pool.query('UPDATE pet_photos SET thumb = $1, thumb_type = $2 WHERE id = $3', [
        small,
        contentType,
        photoId
      ]);
    },
    async clearPetPhotoContent(photoId) {
      await pool.query('UPDATE pet_photos SET content = $1 WHERE id = $2', [Buffer.alloc(0), photoId]);
    },
    async petPhotosForMatching(kind, species) {
      return all(
        'SELECT id, pet_id, embedding FROM pet_photos WHERE kind = $1 AND species = $2 AND embedding IS NOT NULL',
        [kind, species]
      );
    },
    async petPhotosMissingEmbedding(limit) {
      return all('SELECT * FROM pet_photos WHERE embedding IS NULL ORDER BY id LIMIT $1', [limit]);
    },
    async petPhotosForPet(petId) {
      return all(
        `SELECT id, pet_id, content_type, thumb_type FROM pet_photos
         WHERE kind = 'report' AND pet_id = $1 ORDER BY id`,
        [petId]
      );
    },
```

- [ ] **Step 6: Confirmar que la suite completa sigue en verde**

Run: `npm test`
Expected: PASS — esto no prueba Postgres de verdad (la suite corre sobre
SQLite), pero confirma que el archivo sigue cargando y nada existente se
rompió.

- [ ] **Step 7: Commit**

```bash
git add src/store/sqlite.js src/store/postgres.js test/pets-schema.test.js
git commit -m "Agrega el esquema de mascotas perdidas (pets, pet_photos, pet_subscriptions) a los dos adaptadores"
```

---

### Task 3: Capa de dominio `src/pets.js`

**Files:**
- Create: `src/pets.js`
- Test: `test/pets-schema.test.js` se extiende (mismo archivo del Task 2, sección nueva) para probar la capa de dominio, no solo el adaptador crudo.

**Interfaces:**
- Consumes: todos los métodos del adaptador del Task 2.
- Produces: `createPetStore(adapter)` → objeto con `addPet`, `getPet`,
  `markPetResolved`, `addPetPhoto`, `getPetPhoto`, `setPetPhotoEmbedding`,
  `setPetPhotoThumbnail`, `clearPetPhotoContent`, `petPhotosForMatching`
  (embeddings ya parseados a array de números), `petPhotosMissingEmbedding`,
  `petPhotosForPet`.

- [ ] **Step 1: Agregar la prueba que exige el parseo del embedding**

Al final de `test/pets-schema.test.js`:

```js
const { createPetStore } = require('../src/pets');

test('createPetStore.petPhotosForMatching devuelve el embedding ya parseado', async () => {
  const adapter = await createSqliteAdapter(':memory:');
  const petStore = createPetStore(adapter);
  const pet = await petStore.addPet({ species: 'dog', petName: null, description: null, contact: '300 000 0000' });
  const photo = await petStore.addPetPhoto({
    petId: pet.id, kind: 'report', species: 'dog', content: Buffer.from('f'), contentType: 'image/jpeg'
  });
  await petStore.setPetPhotoEmbedding(photo.id, [0.5, 0.25, 0.1], 'modelo-test');

  const candidates = await petStore.petPhotosForMatching('report', 'dog');
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].embedding, [0.5, 0.25, 0.1]);
  assert.equal(typeof candidates[0].embedding[0], 'number');
});
```

- [ ] **Step 2: Correr, confirmar que falla**

Run: `npx node --test test/pets-schema.test.js`
Expected: FAIL — `Cannot find module '../src/pets'`.

- [ ] **Step 3: Crear `src/pets.js`**

```js
// Capa de dominio para mascotas perdidas — espejo liviano de src/people.js,
// pero sin nada de lo que ese archivo necesita para PERSONAS (búsqueda por
// nombre, fonética, ancla de rescate). Una mascota no tiene nombre que buscar
// ni un timeline de estados: un reporte es un hecho, no una serie.
//
// El embedding vuelve de la base como TEXTO en SQLite y ya parseado en
// Postgres (columna JSONB) — la misma diferencia que ya resuelve
// withParsedDetail() en people.js para face_detail. Se normaliza aquí, una
// sola vez, para que nadie que compare dos embeddings tenga que acordarse de
// cuál motor está corriendo.
function parseEmbeddingRow(row) {
  if (row.embedding == null) return row;
  const embedding = typeof row.embedding === 'string' ? JSON.parse(row.embedding) : row.embedding;
  return { ...row, embedding };
}

function createPetStore(adapter) {
  return {
    async addPet({ species, petName, description, contact }) {
      return adapter.insertPet({ species, petName, description, contact });
    },
    async getPet(id) {
      return adapter.getPet(id);
    },
    async markPetResolved(id) {
      return adapter.markPetResolved(id);
    },
    async addPetPhoto(fields) {
      return adapter.insertPetPhoto(fields);
    },
    async getPetPhoto(id) {
      const row = await adapter.getPetPhoto(id);
      return row ? parseEmbeddingRow(row) : row;
    },
    async setPetPhotoEmbedding(photoId, embedding, model) {
      return adapter.setPetPhotoEmbedding(photoId, embedding, model);
    },
    async setPetPhotoThumbnail(photoId, thumb) {
      return adapter.setPetPhotoThumbnail(photoId, thumb);
    },
    async clearPetPhotoContent(photoId) {
      return adapter.clearPetPhotoContent(photoId);
    },
    async petPhotosForMatching(kind, species) {
      const rows = await adapter.petPhotosForMatching(kind, species);
      return rows.map(parseEmbeddingRow);
    },
    async petPhotosMissingEmbedding(limit) {
      return adapter.petPhotosMissingEmbedding(limit);
    },
    async petPhotosForPet(petId) {
      return adapter.petPhotosForPet(petId);
    }
  };
}

module.exports = { createPetStore };
```

- [ ] **Step 4: Correr, confirmar que pasa**

Run: `npm test`
Expected: PASS — toda la suite, incluidas las pruebas nuevas.

- [ ] **Step 5: Commit**

```bash
git add src/pets.js test/pets-schema.test.js
git commit -m "Agrega la capa de dominio de mascotas (src/pets.js)"
```

---

### Task 4: Servicio de embeddings en Python — `pet-matcher/`

**Files:**
- Create: `pet-matcher/requirements.txt`
- Create: `pet-matcher/model.py`
- Create: `pet-matcher/app.py`
- Create: `pet-matcher/test_app.py`
- Create: `pet-matcher/README.md`

**Interfaces:**
- Produces: `POST /embed` (multipart, campo `image`) →
  `{ "embedding": [...512 floats...], "model": "AvitoTech/CLIP-ViT-base-for-animal-identification" }`.
  Sin autenticación (decisión explícita, ver spec).

- [ ] **Step 1: `requirements.txt`**

```
flask==3.0.3
transformers==4.44.0
torch==2.4.0
pillow==10.4.0
pytest==8.3.2
```

- [ ] **Step 2: Escribir la prueba (falla: `app.py` no existe)**

`pet-matcher/test_app.py`:

```python
import io
from PIL import Image
from app import create_app


def fake_embed(image):
    return [0.1, 0.2, 0.3]


def make_test_client():
    app = create_app(embed_fn=fake_embed)
    app.testing = True
    return app.test_client()


def make_test_image_bytes():
    img = Image.new('RGB', (10, 10), color=(255, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format='JPEG')
    buf.seek(0)
    return buf


def test_embed_returns_the_vector_and_model_name():
    client = make_test_client()
    resp = client.post(
        '/embed',
        data={'image': (make_test_image_bytes(), 'foto.jpg')},
        content_type='multipart/form-data'
    )
    assert resp.status_code == 200
    body = resp.get_json()
    assert body['embedding'] == [0.1, 0.2, 0.3]
    assert 'model' in body


def test_embed_without_image_is_a_400():
    client = make_test_client()
    resp = client.post('/embed', data={}, content_type='multipart/form-data')
    assert resp.status_code == 400


def test_embed_with_unreadable_bytes_is_a_400():
    client = make_test_client()
    resp = client.post(
        '/embed',
        data={'image': (io.BytesIO(b'no es una imagen'), 'foto.jpg')},
        content_type='multipart/form-data'
    )
    assert resp.status_code == 400
```

Run: `cd pet-matcher && pip install -r requirements.txt && pytest -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app'`.

- [ ] **Step 3: `model.py` — carga el modelo real, una sola vez**

```python
"""Calcula el embedding de una foto de perro o gato.

Modelo: AvitoTech/CLIP-ViT-base-for-animal-identification (Apache 2.0),
afinado para distinguir individuos de perros y gatos — no personas, y no
"¿hay un animal en la foto?": eso lo asume el formulario que pide la especie,
no este modelo.
"""
from transformers import CLIPModel, CLIPImageProcessor
import torch

MODEL_NAME = "AvitoTech/CLIP-ViT-base-for-animal-identification"

_model = None
_processor = None


def _load():
    global _model, _processor
    if _model is None:
        _processor = CLIPImageProcessor.from_pretrained(MODEL_NAME)
        _model = CLIPModel.from_pretrained(MODEL_NAME)
        _model.eval()
    return _model, _processor


def embed_image(pil_image):
    model, processor = _load()
    inputs = processor(images=pil_image, return_tensors="pt")
    with torch.no_grad():
        features = model.get_image_features(**inputs)
    return features[0].tolist()
```

- [ ] **Step 4: `app.py` — el servidor, con el modelo inyectable para pruebas**

```python
"""Servicio de embeddings para mascotas. Un único endpoint: recibe una foto,
devuelve un vector. No compara nada y no guarda nada — esa lógica y las
reglas de privacidad viven en el lado Node (src/petmatch.js), igual que hoy
Rekognition solo compara y el resto vive en facematch.js.

Sin autenticación todavía — ver docs/superpowers/specs/2026-08-15-mascotas-
perdidas-design.md, "Pendiente antes de producción". No exponer a internet
sin agregarla primero.
"""
import io
from flask import Flask, request, jsonify
from PIL import Image

from model import embed_image, MODEL_NAME


def create_app(embed_fn=None):
    app = Flask(__name__)
    embed = embed_fn or embed_image

    @app.route('/embed', methods=['POST'])
    def embed_route():
        if 'image' not in request.files:
            return jsonify({'error': 'falta el archivo image'}), 400
        raw = request.files['image'].read()
        try:
            image = Image.open(io.BytesIO(raw)).convert('RGB')
        except Exception:
            return jsonify({'error': 'no se pudo leer la imagen'}), 400
        vector = embed(image)
        return jsonify({'embedding': vector, 'model': MODEL_NAME})

    return app


if __name__ == '__main__':
    create_app().run(host='0.0.0.0', port=5001)
```

- [ ] **Step 5: Correr la prueba, confirmar que pasa**

Run: `cd pet-matcher && pytest -v`
Expected: PASS — las 3 pruebas en verde. Nótese que esto NO descarga el
modelo real: `fake_embed` lo reemplaza, igual que `fakeMatcher()` reemplaza a
Rekognition en las pruebas de Node.

- [ ] **Step 6: Verificación manual con el modelo real (no automatizada)**

Esto no es un paso de pytest — descargar el modelo real (~800 MB) en cada
corrida de pruebas sería justo lo que este repo evita con sus dobles. Se
verifica una vez, a mano:

```bash
cd pet-matcher
python app.py &
curl -s -F "image=@/ruta/a/una/foto/de/perro.jpg" http://localhost:5001/embed | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['embedding']), d['model'])"
```

Expected: imprime `512 AvitoTech/CLIP-ViT-base-for-animal-identification` (o
el tamaño real de vector que reporte el modelo — algunas variantes de
CLIP-ViT-base devuelven 512, otras 768; anota acá cuál fue, porque
`PET_MATCH_THRESHOLD` en Node no depende del tamaño, pero si el número
cambia vale la pena saberlo). Si `CLIPModel`/`CLIPImageProcessor` no cargan
ese checkpoint (error de arquitectura), revisar la tarjeta del modelo en
HuggingFace por si documenta una clase distinta, y ajustar `model.py` — este
es el único punto del plan donde el contrato exacto del modelo se confirma
contra la red, no contra una prueba.

- [ ] **Step 7: `README.md`**

```markdown
# pet-matcher

Servicio de embeddings para fotos de mascotas (perros y gatos), separado del
resto de encontrados.co (que es Node). No compara ni guarda nada — solo
calcula el vector de una foto. La comparación y las reglas de privacidad
viven en el lado Node (`src/petmatch.js`).

## Instalar y correr local

    cd pet-matcher
    python3 -m venv venv
    source venv/bin/activate
    pip install -r requirements.txt
    python app.py

Queda escuchando en http://localhost:5001. Desde el lado Node, apunta
`PET_MATCH_API_URL=http://localhost:5001` en tu `.env`.

## Probar

    pytest -v

## Contrato

`POST /embed`, multipart con el campo `image` →
`{ "embedding": [...], "model": "..." }`.

**Sin autenticación todavía.** No exponer este servicio a internet sin
agregar un secreto compartido primero (ver el documento de diseño en
`docs/superpowers/specs/`).
```

- [ ] **Step 8: Commit**

```bash
git add pet-matcher/
git commit -m "Agrega el servicio de embeddings de mascotas en Python (pet-matcher/)"
```

---

### Task 5: Cliente Node del servicio — `src/petfaces.js`

**Files:**
- Create: `src/petfaces.js`
- Test: `test/petfaces.test.js` (nuevo)

**Interfaces:**
- Consumes: `PET_MATCH_API_URL` (env var), `fetch`/`FormData`/`Blob` globales
  de Node 22.
- Produces: `createPetMatcher() → { enabled, status, embed(bytes, contentType) }`.
  `embed` devuelve `{ embedding, model }` o `null` si el servicio está
  apagado, caído, o responde con error — nunca lanza.

- [ ] **Step 1: Escribir la prueba (falla: el módulo no existe)**

`test/petfaces.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

async function fakePetMatcherServer(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('sin PET_MATCH_API_URL, el matcher queda deshabilitado y embed() devuelve null', async () => {
  delete process.env.PET_MATCH_API_URL;
  const { createPetMatcher } = require('../src/petfaces');
  const matcher = createPetMatcher();
  assert.equal(matcher.enabled, false);
  assert.equal(await matcher.embed(Buffer.from('x'), 'image/jpeg'), null);
});

test('con la URL puesta, embed() llama al servicio y devuelve el vector', async () => {
  const { server, base } = await fakePetMatcherServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ embedding: [0.1, 0.2], model: 'modelo-fake' }));
  });
  process.env.PET_MATCH_API_URL = base;
  const { createPetMatcher } = require('../src/petfaces');
  const matcher = createPetMatcher();
  assert.equal(matcher.enabled, true);
  const result = await matcher.embed(Buffer.from('foto'), 'image/jpeg');
  assert.deepEqual(result, { embedding: [0.1, 0.2], model: 'modelo-fake' });
  server.close();
  delete process.env.PET_MATCH_API_URL;
});

test('si el servicio responde con error, embed() devuelve null sin lanzar', async () => {
  const { server, base } = await fakePetMatcherServer((req, res) => {
    res.writeHead(500).end('boom');
  });
  process.env.PET_MATCH_API_URL = base;
  const { createPetMatcher } = require('../src/petfaces');
  const matcher = createPetMatcher();
  assert.equal(await matcher.embed(Buffer.from('foto'), 'image/jpeg'), null);
  server.close();
  delete process.env.PET_MATCH_API_URL;
});

test('si el servicio no responde (nadie escuchando), embed() devuelve null sin lanzar', async () => {
  process.env.PET_MATCH_API_URL = 'http://127.0.0.1:1';
  const { createPetMatcher } = require('../src/petfaces');
  const matcher = createPetMatcher();
  assert.equal(await matcher.embed(Buffer.from('foto'), 'image/jpeg'), null);
  delete process.env.PET_MATCH_API_URL;
});
```

Run: `npx node --test test/petfaces.test.js`
Expected: FAIL — `Cannot find module '../src/petfaces'`.

- [ ] **Step 2: Crear `src/petfaces.js`**

```js
// Proveedor de embeddings de mascotas. Producción: el servicio propio en
// pet-matcher/ (ver ese folder). Sin PET_MATCH_API_URL, el matching de
// mascotas queda apagado — mismo contrato de degradación que src/faces.js
// tiene para Rekognition: nunca lanza, nunca tumba un reporte.
function createPetMatcher() {
  const apiUrl = process.env.PET_MATCH_API_URL;
  if (!apiUrl) {
    return {
      enabled: false,
      status: 'deshabilitado (sin PET_MATCH_API_URL)',
      async embed() {
        return null;
      }
    };
  }
  return {
    enabled: true,
    status: `activo (${apiUrl})`,
    async embed(bytes, contentType) {
      try {
        const form = new FormData();
        form.append('image', new Blob([bytes], { type: contentType || 'image/jpeg' }), 'foto.jpg');
        const res = await fetch(`${apiUrl}/embed`, { method: 'POST', body: form });
        if (!res.ok) {
          console.error(`[petfaces] /embed respondió ${res.status}`);
          return null;
        }
        const body = await res.json();
        return { embedding: body.embedding, model: body.model };
      } catch (e) {
        console.error('[petfaces] no se pudo llamar al servicio de mascotas:', e.message);
        return null;
      }
    }
  };
}

module.exports = { createPetMatcher };
```

- [ ] **Step 3: Correr, confirmar que pasa**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/petfaces.js test/petfaces.test.js
git commit -m "Agrega el cliente Node del servicio de embeddings de mascotas (src/petfaces.js)"
```

---

### Task 6: Orquestación — `src/petmatch.js`

**Files:**
- Create: `src/petmatch.js`
- Test: `test/petmatch.test.js` (nuevo)

**Interfaces:**
- Consumes: `createPetStore` (Task 3), `createPetMatcher`-shaped matcher
  (Task 5 — o un doble en pruebas), `makeThumbnail` de `src/thumbs.js`,
  `toMatchable` de `src/photo.js`.
- Produces:
  - `processPetPhoto(petStore, petMatcher, { petId, kind, species, subscriptionId, bytes, contentType }) → { photo, matches }`
  - `backfillUnindexedPetPhotos(petStore, petMatcher, limit) → { ok, pending, processed, failed }`
  - `PET_MATCH_THRESHOLD` (número, exportado para que la ruta pueda mostrarlo si hace falta depurar)

- [ ] **Step 1: Escribir las pruebas (fallan: el módulo no existe)**

`test/petmatch.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createPetStore } = require('../src/pets');

// Vectores ya normalizados a propósito: la similitud coseno entre dos
// vectores idénticos es 1 (100%), y entre estos dos "distintos" cae bajo
// cualquier umbral razonable — no hace falta un modelo real para probar la
// lógica de comparación.
const VECTOR_A = [1, 0, 0];
const VECTOR_B = [0, 1, 0];

function fakePetMatcherFor(vectors) {
  let calls = 0;
  return {
    enabled: true,
    status: 'fake',
    async embed(bytes) {
      calls++;
      const key = bytes.toString('utf8');
      return vectors[key] ? { embedding: vectors[key], model: 'fake-model' } : null;
    },
    get calls() {
      return calls;
    }
  };
}

async function setup() {
  const adapter = await createSqliteAdapter(':memory:');
  const petStore = createPetStore(adapter);
  return { petStore };
}

test('una foto de reporte sin coincidencias previas se guarda y no arma ningún match', async () => {
  const { petStore } = await setup();
  const { processPetPhoto } = require('../src/petmatch');
  const matcher = fakePetMatcherFor({ toby: VECTOR_A });

  const pet = await petStore.addPet({ species: 'dog', petName: 'Toby', description: null, contact: '300 111 2222' });
  const { photo, matches } = await processPetPhoto(petStore, matcher, {
    petId: pet.id,
    kind: 'report',
    species: 'dog',
    bytes: Buffer.from('toby'),
    contentType: 'image/jpeg'
  });

  assert.equal(matches.length, 0);
  const stored = await petStore.getPetPhoto(photo.id);
  assert.deepEqual(stored.embedding, VECTOR_A);
  assert.ok(stored.content.length > 0, 'una foto de REPORTE sí conserva sus bytes');
});

test('una foto "encontré" que coincide con un reporte muestra el contacto de quien lo puso, y no guarda sus bytes', async () => {
  const { petStore } = await setup();
  const { processPetPhoto } = require('../src/petmatch');
  const matcher = fakePetMatcherFor({ toby: VECTOR_A, encontrado: VECTOR_A });

  const pet = await petStore.addPet({ species: 'dog', petName: 'Toby', description: null, contact: '300 111 2222' });
  await processPetPhoto(petStore, matcher, {
    petId: pet.id, kind: 'report', species: 'dog', bytes: Buffer.from('toby'), contentType: 'image/jpeg'
  });

  const { photo, matches } = await processPetPhoto(petStore, matcher, {
    kind: 'query', species: 'dog', bytes: Buffer.from('encontrado'), contentType: 'image/jpeg'
  });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].pet_id, pet.id);
  assert.ok(matches[0].similarity > 90);

  const stored = await petStore.getPetPhoto(photo.id);
  assert.equal(stored.content.length, 0, 'la foto de quien encontró a la mascota nunca se conserva');
});

test('no cruza especies: un perro parecido no aparece al buscar un gato', async () => {
  const { petStore } = await setup();
  const { processPetPhoto } = require('../src/petmatch');
  const matcher = fakePetMatcherFor({ perro: VECTOR_A, buscando: VECTOR_A });

  const pet = await petStore.addPet({ species: 'dog', petName: null, description: null, contact: '300 111 2222' });
  await processPetPhoto(petStore, matcher, {
    petId: pet.id, kind: 'report', species: 'dog', bytes: Buffer.from('perro'), contentType: 'image/jpeg'
  });

  const { matches } = await processPetPhoto(petStore, matcher, {
    kind: 'query', species: 'cat', bytes: Buffer.from('buscando'), contentType: 'image/jpeg'
  });
  assert.equal(matches.length, 0, 'especies distintas nunca deben coincidir');
});

test('sin PET_MATCH_API_URL (matcher deshabilitado), la foto se guarda igual y sin comparar', async () => {
  const { petStore } = await setup();
  const { processPetPhoto } = require('../src/petmatch');
  const { createPetMatcher } = require('../src/petfaces');
  delete process.env.PET_MATCH_API_URL;
  const matcher = createPetMatcher();

  const pet = await petStore.addPet({ species: 'dog', petName: null, description: null, contact: '300 111 2222' });
  const { photo, matches } = await processPetPhoto(petStore, matcher, {
    petId: pet.id, kind: 'report', species: 'dog', bytes: Buffer.from('perro'), contentType: 'image/jpeg'
  });
  assert.equal(matches.length, 0);
  const stored = await petStore.getPetPhoto(photo.id);
  assert.equal(stored.embedding, null, 'sin servicio, no hay embedding que guardar');
  assert.ok(stored.content.length > 0, 'la foto se guarda de todos modos');
});

test('backfillUnindexedPetPhotos recoge lo que quedó sin embedding y lo compara', async () => {
  const { petStore } = await setup();
  const { processPetPhoto, backfillUnindexedPetPhotos } = require('../src/petmatch');
  delete process.env.PET_MATCH_API_URL;
  const { createPetMatcher } = require('../src/petfaces');
  const offlineMatcher = createPetMatcher();

  const pet = await petStore.addPet({ species: 'dog', petName: null, description: null, contact: '300 111 2222' });
  await processPetPhoto(petStore, offlineMatcher, {
    petId: pet.id, kind: 'report', species: 'dog', bytes: Buffer.from('perro'), contentType: 'image/jpeg'
  });

  const onlineMatcher = fakePetMatcherFor({ perro: VECTOR_A });
  const result = await backfillUnindexedPetPhotos(petStore, onlineMatcher, 100);
  assert.equal(result.processed, 1);

  const stored = (await petStore.petPhotosForMatching('report', 'dog'))[0];
  assert.deepEqual(stored.embedding, VECTOR_A);
});
```

Run: `npx node --test test/petmatch.test.js`
Expected: FAIL — `Cannot find module '../src/petmatch'`.

- [ ] **Step 2: Crear `src/petmatch.js`**

```js
// Orquestación de mascotas — espejo de src/facematch.js, pero comparando
// embeddings en JS en vez de usar la colección administrada de Rekognition:
// pet-matcher/ (ver ese folder) solo calcula vectores, no compara nada.
//
// Dos tipos de foto, igual que con personas:
//   'report' — mascota reportada como perdida. Se guarda y se publica.
//   'query'  — foto de quien encontró una mascota. Se compara y se borra —
//              solo el embedding sobrevive, nunca los bytes.
const { toMatchable } = require('./photo');
const { makeThumbnail } = require('./thumbs');

const PET_MATCH_THRESHOLD = parseFloat(process.env.PET_MATCH_THRESHOLD || '80');

function cosineSimilarity(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Compara contra el lado OPUESTO (report ⟷ query), filtrando por especie —
// nunca cruza perro con gato. Devuelve [{ id, pet_id, similarity }] ordenado
// de mayor a menor similitud, solo por encima del umbral.
async function matchPetPhoto(petStore, { kind, species, embedding }) {
  const oppositeKind = kind === 'report' ? 'query' : 'report';
  const candidates = await petStore.petPhotosForMatching(oppositeKind, species);
  return candidates
    .map((c) => ({ ...c, similarity: cosineSimilarity(embedding, c.embedding) * 100 }))
    .filter((c) => c.similarity >= PET_MATCH_THRESHOLD)
    .sort((a, b) => b.similarity - a.similarity);
}

// Guarda la foto, pide su embedding, compara, y (solo para kind='report')
// genera la miniatura que ve la ficha pública. Nunca lanza: un servicio de
// embeddings caído apaga el matching, no tumba el reporte — mismo principio
// que processPhoto en facematch.js.
async function processPetPhoto(petStore, petMatcher, { petId, kind, species, subscriptionId, bytes, contentType }) {
  const usable = await toMatchable(bytes, contentType);

  const photo = await petStore.addPetPhoto({
    petId: petId || null,
    kind,
    species,
    subscriptionId: subscriptionId || null,
    content: usable ? usable.bytes : bytes,
    contentType: usable ? usable.contentType : contentType
  });

  if (!usable) {
    console.warn(`[petmatch] foto ${photo.id} ilegible (${contentType}) — guardada sin comparar`);
    photo.unreadable = true;
    return { photo, matches: [] };
  }
  const content = usable.bytes;

  if (kind === 'report') {
    const thumb = await makeThumbnail(content, null);
    if (thumb) await petStore.setPetPhotoThumbnail(photo.id, { small: thumb.bytes, contentType: thumb.contentType });
  }

  if (!petMatcher.enabled) {
    console.warn(`[petmatch] matcher deshabilitado — foto ${photo.id} guardada sin comparar (backfill la recoge después)`);
    return { photo, matches: [] };
  }

  const result = await petMatcher.embed(content, contentType);
  if (!result) return { photo, matches: [] };
  await petStore.setPetPhotoEmbedding(photo.id, result.embedding, result.model);

  const matches = await matchPetPhoto(petStore, { kind, species, embedding: result.embedding });

  // La foto de quien encontró una mascota nunca se conserva — solo su
  // embedding, para que un reporte futuro sí pueda coincidir con ella.
  if (kind === 'query') await petStore.clearPetPhotoContent(photo.id);

  if (kind === 'report' && matches.length) {
    // Hoy no hay contacto de quien encontró la mascota (pet_subscriptions
    // existe pero no se usa todavía — ver el plan), así que no hay a quién
    // avisar de este lado. Se deja visible en el log para operación.
    console.log(
      `[petmatch] el reporte de la mascota ${photo.pet_id} coincide con ${matches.length} avistamiento(s) previo(s), sin contacto para avisar en esta versión`
    );
  }

  return { photo, matches };
}

// Red de seguridad: fotos que quedaron sin embedding porque el servicio
// estaba caído o sin configurar al momento de subirlas. Mismo rol que
// backfillUnindexedPhotos en facematch.js — no es el camino principal.
async function backfillUnindexedPetPhotos(petStore, petMatcher, limit = 100) {
  if (!petMatcher.enabled) {
    return { ok: false, error: 'El servicio de mascotas no está activo.', processed: 0 };
  }
  const pending = await petStore.petPhotosMissingEmbedding(limit);
  let processed = 0;
  let failed = 0;
  for (const photo of pending) {
    try {
      const bytes = Buffer.isBuffer(photo.content) ? photo.content : Buffer.from(photo.content);
      const result = await petMatcher.embed(bytes, photo.content_type);
      if (result) {
        await petStore.setPetPhotoEmbedding(photo.id, result.embedding, result.model);
        processed++;
      } else {
        failed++;
      }
    } catch (e) {
      console.error(`[petmatch:backfill] foto ${photo.id} falló:`, e.message);
      failed++;
    }
  }
  return { ok: true, pending: pending.length, processed, failed };
}

module.exports = { processPetPhoto, backfillUnindexedPetPhotos, PET_MATCH_THRESHOLD, cosineSimilarity };
```

- [ ] **Step 3: Correr, confirmar que pasa**

Run: `npx node --test test/petmatch.test.js`
Expected: PASS — las 5 pruebas.

- [ ] **Step 4: Correr la suite completa**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/petmatch.js test/petmatch.test.js
git commit -m "Agrega la orquestación de matching de mascotas (src/petmatch.js)"
```

---

### Task 7: Doble de pruebas para el servicio Python — `fakePetMatcher()`

**Files:**
- Modify: `test/helpers.js`

**Interfaces:**
- Produces: `fakePetMatcher() → { received, base, respondWith(fn), stop() }` —
  mismo patrón que `fakeSendgrid`/`fakeGithub`: un servidor HTTP real en
  `127.0.0.1`, para que las pruebas de rutas (Task 8) ejerciten el camino
  HTTP de verdad sin depender de Python.

- [ ] **Step 1: Agregar `fakePetMatcher` a `test/helpers.js`**

No hace falta una prueba dedicada para este helper — se prueba por uso, en
`test/pets.test.js` (Task 8). Al final de `test/helpers.js`, antes del
`module.exports`:

```js
// Stand-in del servicio Python (pet-matcher/), para que las pruebas de rutas
// ejerciten POST /embed de verdad sin necesitar Python instalado. Por
// omisión responde un vector fijo; respondWith() lo cambia cuando una prueba
// necesita un vector específico (para forzar o evitar una coincidencia).
async function fakePetMatcher() {
  const received = [];
  let vector = [1, 0, 0];
  const server = http.createServer((req, res) => {
    received.push({ url: req.url });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ embedding: vector, model: 'fake-pet-model' }));
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.PET_MATCH_API_URL = base;
  return {
    received,
    base,
    respondWith(v) {
      vector = v;
    },
    stop() {
      server.close();
      delete process.env.PET_MATCH_API_URL;
    }
  };
}
```

Y en el `module.exports` del final del archivo, agregar `fakePetMatcher` a
la lista.

- [ ] **Step 2: Confirmar que la suite sigue en verde**

Run: `npm test`
Expected: PASS — este helper todavía no lo usa ninguna prueba, así que solo
confirma que el archivo sigue cargando bien.

- [ ] **Step 3: Commit**

```bash
git add test/helpers.js
git commit -m "Agrega fakePetMatcher() a los dobles de prueba compartidos"
```

---

### Task 8: Rutas web — `src/routes/pets.js`

**Files:**
- Create: `src/routes/pets.js`
- Test: `test/pets.test.js` (nuevo)

**Interfaces:**
- Consumes: `createPetStore` (Task 3), `processPetPhoto` (Task 6), `upload`
  (Task 1), `layout`/`esc` de `src/html.js`.
- Produces: `petRoutes(petStore, petMatcher) → express.Router` con:
  - `GET /mascotas`
  - `GET+POST /mascotas/reporte`
  - `GET+POST /mascotas/encontre`
  - `GET /mascota/:id`
  - `POST /mascota/:id/encontrado`
  - `GET /pet-photo/:id`, `GET /pet-photo/:id/thumb`

- [ ] **Step 1: Escribir la prueba end-to-end (falla: la ruta no existe)**

`test/pets.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { fakePetMatcher } = require('./helpers');

async function photoBytes(color) {
  return sharp({ create: { width: 300, height: 300, channels: 3, background: color } })
    .jpeg()
    .toBuffer();
}

async function startApp() {
  const app = await createApp(await createSqliteAdapter(':memory:'));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('reportar una mascota perdida la publica, y "encontré" con la misma foto muestra el contacto', async (t) => {
  const pm = await fakePetMatcher();
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    pm.stop();
  });

  const fd = new FormData();
  fd.set('species', 'dog');
  fd.set('pet_name', 'Toby');
  fd.set('description', 'Mediano, negro, collar rojo');
  fd.set('contact_phone', '300 111 2222');
  fd.append('photos', new File([await photoBytes({ r: 10, g: 10, b: 10 })], 'toby.jpg', { type: 'image/jpeg' }));
  const reportRes = await fetch(`${base}/mascotas/reporte`, { method: 'POST', body: fd, redirect: 'manual' });
  assert.equal(reportRes.status, 303);
  const location = reportRes.headers.get('location');
  assert.match(location, /^\/mascota\/\d+\?reported=1$/);

  const fichaHtml = await (await fetch(`${base}${location}`)).text();
  assert.match(fichaHtml, /Toby/);
  assert.match(fichaHtml, /Mediano, negro, collar rojo/);
  assert.match(fichaHtml, /pet-photo\/1\/thumb/);

  pm.respondWith([1, 0, 0]); // el mismo vector que ya devolvió para la foto del reporte
  const fd2 = new FormData();
  fd2.set('species', 'dog');
  fd2.append('photo', new File([await photoBytes({ r: 200, g: 200, b: 200 })], 'encontrado.jpg', { type: 'image/jpeg' }));
  const html = await (await fetch(`${base}/mascotas/encontre`, { method: 'POST', body: fd2 })).text();

  assert.match(html, /Toby/);
  assert.match(html, /300 111 2222/);
});

test('especies distintas no coinciden, y sin coincidencia lo dice claro', async (t) => {
  const pm = await fakePetMatcher();
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    pm.stop();
  });

  const fd = new FormData();
  fd.set('species', 'cat');
  fd.append('photos', new File([await photoBytes({ r: 1, g: 1, b: 1 })], 'gato.jpg', { type: 'image/jpeg' }));
  fd.set('contact_email', 'duena@ejemplo.com');
  await fetch(`${base}/mascotas/reporte`, { method: 'POST', body: fd, redirect: 'manual' });

  const fd2 = new FormData();
  fd2.set('species', 'dog');
  fd2.append('photo', new File([await photoBytes({ r: 1, g: 1, b: 1 })], 'perro.jpg', { type: 'image/jpeg' }));
  const html = await (await fetch(`${base}/mascotas/encontre`, { method: 'POST', body: fd2 })).text();
  assert.match(html, /Nadie ha reportado una mascota parecida/);
});

test('la foto de quien encontró la mascota nunca se puede servir públicamente', async (t) => {
  const pm = await fakePetMatcher();
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    pm.stop();
  });

  const fd = new FormData();
  fd.set('species', 'dog');
  fd.append('photos', new File([await photoBytes({ r: 5, g: 5, b: 5 })], 'p.jpg', { type: 'image/jpeg' }));
  fd.set('contact_phone', '300 999 8888');
  await fetch(`${base}/mascotas/reporte`, { method: 'POST', body: fd, redirect: 'manual' });

  const fd2 = new FormData();
  fd2.set('species', 'dog');
  fd2.append('photo', new File([await photoBytes({ r: 5, g: 5, b: 5 })], 'q.jpg', { type: 'image/jpeg' }));
  await fetch(`${base}/mascotas/encontre`, { method: 'POST', body: fd2 });

  // La foto 1 es el reporte (se sirve), la 2 es la de "encontré" (nunca).
  assert.equal((await fetch(`${base}/pet-photo/1`)).status, 200);
  assert.equal((await fetch(`${base}/pet-photo/2`)).status, 404);
  assert.equal((await fetch(`${base}/pet-photo/2/thumb`)).status, 404);
});

test('sin PET_MATCH_API_URL, el formulario de "encontré" lo dice y no rompe nada', async (t) => {
  delete process.env.PET_MATCH_API_URL;
  const { server, base } = await startApp();
  t.after(() => server.close());

  const fd = new FormData();
  fd.set('species', 'dog');
  fd.append('photo', new File([await photoBytes({ r: 7, g: 7, b: 7 })], 'q.jpg', { type: 'image/jpeg' }));
  const html = await (await fetch(`${base}/mascotas/encontre`, { method: 'POST', body: fd })).text();
  assert.match(html, /no está disponible/);
});

test('marcar una mascota como encontrada lo refleja en su ficha', async (t) => {
  const pm = await fakePetMatcher();
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    pm.stop();
  });

  const fd = new FormData();
  fd.set('species', 'cat');
  fd.append('photos', new File([await photoBytes({ r: 2, g: 2, b: 2 })], 'g.jpg', { type: 'image/jpeg' }));
  fd.set('contact_email', 'duena@ejemplo.com');
  const res = await fetch(`${base}/mascotas/reporte`, { method: 'POST', body: fd, redirect: 'manual' });
  const location = res.headers.get('location').split('?')[0];

  await fetch(`${base}${location}/encontrado`, { method: 'POST' });
  const html = await (await fetch(`${base}${location}`)).text();
  assert.match(html, /ya fue encontrada/);
});
```

Run: `npx node --test test/pets.test.js`
Expected: FAIL — 404 en todas las rutas, porque `src/routes/pets.js` no
existe ni está montado.

- [ ] **Step 2: Crear `src/routes/pets.js`**

```js
const express = require('express');
const { upload } = require('../upload');
const { esc, layout } = require('../html');
const { processPetPhoto } = require('../petmatch');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const MAX_PET_REPORT_PHOTOS = 3;
const SPECIES_LABEL = { dog: 'Perro', cat: 'Gato' };

function parseSpecies(raw) {
  return raw === 'dog' || raw === 'cat' ? raw : null;
}

// Mismo criterio que composeContact() en src/routes/web.js — con uno basta.
// No se reusa esa función porque no está exportada y son tres líneas: menos
// riesgo copiarlas que abrir el módulo de personas por esto.
function composeContact({ phone, email }) {
  return [phone, email].map((v) => String(v || '').trim()).filter(Boolean).join(' · ');
}

function petRoutes(petStore, petMatcher) {
  const router = express.Router();

  router.get('/mascotas', (req, res) => {
    res.send(
      layout(
        'Mascotas perdidas',
        `<h1 class="compact">Mascotas perdidas</h1>
<p class="subtle">Comparamos fotos de mascotas para ayudar a reunirlas con su familia.</p>
<div class="stack">
  <a class="big-btn search" href="/mascotas/reporte">🐾 Perdí una mascota</a>
  <a class="big-btn secondary" href="/mascotas/encontre">👀 Encontré una mascota</a>
</div>`,
        { fullTitle: 'Mascotas perdidas — encontrados.co', path: '/mascotas' }
      )
    );
  });

  function reportForm() {
    return `<form class="stack compact" method="post" action="/mascotas/reporte" enctype="multipart/form-data" data-require-photos>
  <label class="file-label"><span>📷 Fotos de tu mascota * (1 a 3)</span>
    <input type="file" name="photos" accept="image/*" multiple required></label>
  <label class="field-label"><span>Especie *</span>
    <select name="species" required>
      <option value="dog">Perro</option>
      <option value="cat">Gato</option>
    </select></label>
  <label class="field-label"><span>Nombre de tu mascota (opcional)</span>
    <input name="pet_name" maxlength="120" placeholder="Ej. Toby"></label>
  <label class="field-label"><span>Descripción (color, tamaño, señas)</span>
    <textarea name="description" rows="2" placeholder="Ej. Perro mediano, negro, collar rojo"></textarea></label>
  <label class="field-label"><span>Tu teléfono para que te contacten</span>
    <input name="contact_phone" inputmode="tel" autocomplete="tel" maxlength="120" placeholder="Ej. 300 123 4567"></label>
  <label class="field-label"><span>Tu correo</span>
    <input name="contact_email" type="email" inputmode="email" autocomplete="email" maxlength="120" placeholder="tucorreo@ejemplo.com"></label>
  <p class="subtle contact-note">Con uno basta.</p>
  <button>Reporta mascota perdida</button>
</form>
<script>
document.addEventListener('submit', function (ev) {
  var f = ev.target;
  if (!f.matches('form[data-require-photos]')) return;
  if (!f.querySelector('input[type=file]').files.length) {
    ev.preventDefault();
    ev.stopImmediatePropagation();
    alert('Sube al menos una foto de tu mascota.');
  }
}, true);
</script>`;
  }

  router.get('/mascotas/reporte', (req, res) => {
    res.send(
      layout('Reporta tu mascota perdida', `<h1 class="compact">Reporta tu mascota perdida</h1>
<p class="subtle">Cuando alguien que encontró una mascota parecida la compare, verá tu contacto y podrá avisarte.</p>
${reportForm()}`, { fullTitle: 'Reporta tu mascota perdida — encontrados.co', path: '/mascotas/reporte' })
    );
  });

  router.post(
    '/mascotas/reporte',
    upload.array('photos', 8),
    wrap(async (req, res) => {
      const species = parseSpecies(req.body.species);
      const petName = String(req.body.pet_name || '').trim();
      const description = String(req.body.description || '').trim();
      const contact = composeContact({ phone: req.body.contact_phone, email: req.body.contact_email });
      const files = (req.files || []).slice(0, MAX_PET_REPORT_PHOTOS);
      if (!species || !contact || !files.length) {
        return res
          .status(400)
          .send(layout('Error', '<p class="error">Faltan datos: hacen falta las fotos, la especie y un teléfono o correo de contacto.</p>'));
      }

      const pet = await petStore.addPet({ species, petName: petName || null, description: description || null, contact });
      let unreadable = 0;
      for (const f of files) {
        const { photo } = await processPetPhoto(petStore, petMatcher, {
          petId: pet.id,
          kind: 'report',
          species,
          bytes: f.buffer,
          contentType: f.mimetype
        });
        if (photo.unreadable) unreadable++;
      }
      const flag = unreadable ? `&fotos_ilegibles=${unreadable}` : '';
      res.redirect(303, `/mascota/${pet.id}?reported=1${flag}`);
    })
  );

  router.get('/mascotas/encontre', (req, res) => {
    res.send(
      layout('¿Encontraste una mascota?', `<h1 class="compact">¿Encontraste una mascota? Mira si alguien la está buscando</h1>
<p class="subtle">Sube una foto de la mascota. La comparamos con las fotos de mascotas reportadas como perdidas y te mostramos el contacto de quien la busca.</p>
<form class="stack compact" method="post" action="/mascotas/encontre" enctype="multipart/form-data">
  <label class="field-label"><span>Especie *</span>
    <select name="species" required>
      <option value="dog">Perro</option>
      <option value="cat">Gato</option>
    </select></label>
  <label class="file-label"><span>📷 Foto de la mascota *</span>
    <input type="file" name="photo" accept="image/*" required></label>
  <button>Comparar</button>
</form>`, { fullTitle: '¿Encontraste una mascota? — encontrados.co', path: '/mascotas/encontre' })
    );
  });

  router.post(
    '/mascotas/encontre',
    upload.single('photo'),
    wrap(async (req, res) => {
      const species = parseSpecies(req.body.species);
      if (!species || !req.file) {
        return res.status(400).send(layout('Error', '<p class="error">Sube una foto y elige la especie.</p>'));
      }

      const { photo, matches } = await processPetPhoto(petStore, petMatcher, {
        kind: 'query',
        species,
        bytes: req.file.buffer,
        contentType: req.file.mimetype
      });

      let body;
      if (photo.unreadable) {
        body = '<div class="error"><p><strong>No pudimos leer esa foto.</strong> Intenta con otra.</p></div>';
      } else if (!petMatcher.enabled) {
        body = '<div class="error"><p>La comparación de mascotas no está disponible en este momento. Inténtalo de nuevo en unos minutos.</p></div>';
      } else if (!matches.length) {
        body = '<div class="error"><p><strong>Nadie ha reportado una mascota parecida todavía.</strong> Vuelve a intentarlo más tarde.</p></div>';
      } else {
        const cards = [];
        for (const m of matches) {
          const pet = await petStore.getPet(m.pet_id);
          if (!pet) continue;
          const label = pet.pet_name || `${SPECIES_LABEL[pet.species]} perdido`;
          cards.push(`<article class="card">
  <h3><a href="/mascota/${pet.id}">${esc(label)}</a></h3>
  <p>🐾 Coincidencia: <strong>${Math.round(m.similarity)}%</strong></p>
  <p><strong>Contacta a quien la busca:</strong> ${esc(pet.contact)}</p>
</article>`);
        }
        body =
          `<h2>${cards.length === 1 ? 'Puede ser esta' : 'Coincidencias encontradas'}</h2>` +
          cards.join('') +
          '<p class="subtle">Verifica siempre antes de entregar la mascota.</p>';
      }

      res.send(
        layout('Resultado', `<h1 class="compact">Resultado</h1>
${body}
<p><a href="/mascotas/encontre">🔍 Consultar otra mascota</a></p>`)
      );
    })
  );

  router.get(
    '/mascota/:id',
    wrap(async (req, res) => {
      const pet = await petStore.getPet(req.params.id);
      if (!pet) return res.status(404).send(layout('No encontrado', '<p>No existe esa mascota.</p>'));
      const photos = await petStore.petPhotosForPet(pet.id);
      const label = pet.pet_name || `${SPECIES_LABEL[pet.species]} perdido`;
      const imgs = photos
        .map((p) => `<img src="/pet-photo/${p.id}/thumb" alt="Foto de ${esc(label)}" width="240" height="240">`)
        .join('');
      const action = pet.resolved_at
        ? '<p class="notice">✅ Esta mascota ya fue encontrada.</p>'
        : `<form method="post" action="/mascota/${pet.id}/encontrado"><button class="secondary">Marcar como encontrada</button></form>`;
      res.send(
        layout(label, `<h1 class="compact">${esc(label)}</h1>
<p>${esc(SPECIES_LABEL[pet.species])}${pet.description ? ' · ' + esc(pet.description) : ''}</p>
${imgs}
${action}`, { path: `/mascota/${pet.id}` })
      );
    })
  );

  router.post(
    '/mascota/:id/encontrado',
    wrap(async (req, res) => {
      const pet = await petStore.getPet(req.params.id);
      if (!pet) return res.status(404).end();
      await petStore.markPetResolved(pet.id);
      res.redirect(303, `/mascota/${pet.id}`);
    })
  );

  router.get(
    '/pet-photo/:id',
    wrap(async (req, res) => {
      const photo = await petStore.getPetPhoto(req.params.id);
      if (!photo || photo.kind !== 'report' || !photo.content || !photo.content.length) {
        return res.status(404).end();
      }
      res.set('Content-Type', photo.content_type);
      res.send(Buffer.isBuffer(photo.content) ? photo.content : Buffer.from(photo.content));
    })
  );

  router.get(
    '/pet-photo/:id/thumb',
    wrap(async (req, res) => {
      const photo = await petStore.getPetPhoto(req.params.id);
      if (!photo || photo.kind !== 'report' || !photo.thumb || !photo.thumb.length) {
        return res.status(404).end();
      }
      res.set('Content-Type', photo.thumb_type || 'image/jpeg');
      res.send(Buffer.isBuffer(photo.thumb) ? photo.thumb : Buffer.from(photo.thumb));
    })
  );

  return router;
}

module.exports = { petRoutes };
```

- [ ] **Step 3: Montar el router en `src/server.js`**

Agregar los `require` (junto a los que ya existen):

```js
const { createStore } = require('./people'); // ya existe — referencia
const { createPetStore } = require('./pets');
const { createPetMatcher } = require('./petfaces');
const { petRoutes } = require('./routes/pets');
```

Dentro de `createApp`, junto a donde se crea `store`/`faceMatcher`:

```js
  const petStore = createPetStore(adapter || (await createAdapter()));
```

Ojo: `createApp` recibe `adapter` como parámetro, y si viene `undefined`
(producción) ya se resuelve una vez más arriba en la línea de `store` — hay
que usar la MISMA instancia de adapter para las dos, no crear una segunda.
Revisar la línea existente `const store = createStore(adapter || (await
createAdapter()));` y capturar ese adapter resuelto en una variable antes de
pasarlo a los dos `createStore`:

```js
  const resolvedAdapter = adapter || (await createAdapter());
  const store = createStore(resolvedAdapter);
  const petStore = createPetStore(resolvedAdapter);
  const petMatcher = createPetMatcher();
```

Y donde se montan los demás routers:

```js
  app.use('/', petRoutes(petStore, petMatcher));
```

(antes de `app.use('/', webRoutes(store, faceMatcher));`, para que quede
junto a los demás — el orden no importa entre estos dos porque sus rutas no
se pisan).

- [ ] **Step 4: Correr la prueba, confirmar que pasa**

Run: `npx node --test test/pets.test.js`
Expected: PASS — las 5 pruebas.

- [ ] **Step 5: Correr la suite completa**

Run: `npm test`
Expected: PASS — nada existente debe romperse por montar un router más.

- [ ] **Step 6: Commit**

```bash
git add src/routes/pets.js src/server.js test/pets.test.js
git commit -m "Agrega las páginas de mascotas perdidas: reportar, buscar por foto y ficha pública"
```

---

### Task 9: Diagnóstico, variables de entorno y documentación

**Files:**
- Modify: `src/routes/api.js`
- Modify: `src/server.js` (pasar `petMatcher` a `apiRoutes`)
- Modify: `.env.example`
- Modify: `agent.md`

**Interfaces:**
- Consumes: `petMatcher.enabled`/`petMatcher.status` (Task 5),
  `backfillUnindexedPetPhotos` (Task 6).
- Produces: `GET /api/diag` con un bloque `pet_matching: { api_url_present, enabled, status }`.
  `POST/GET /api/reindex` también recoge fotos de mascotas sin embedding —
  mismo rol que ya cumple para personas, para que `backfillUnindexedPetPhotos`
  (Task 6) no quede como código sin ningún camino que lo llame.

- [ ] **Step 1: Extender la firma de `apiRoutes` y el bloque de diagnóstico**

En `src/routes/api.js`, cambiar:

```js
function apiRoutes(store, matcher) {
```

por:

```js
function apiRoutes(store, matcher, petStore, petMatcher) {
```

Y agregar el `require` del backfill de mascotas junto al de personas:

```js
const { backfillUnindexedPetPhotos } = require('../petmatch');
```

Dentro del handler de `GET /diag`, en el objeto `out`, agregar junto a
`faces`:

```js
        pet_matching: {
          api_url_present: !!process.env.PET_MATCH_API_URL,
          enabled: !!(petMatcher && petMatcher.enabled),
          status: (petMatcher && petMatcher.status) || 'sin inicializar'
        },
```

- [ ] **Step 2: Sumar el backfill de mascotas a `POST/GET /api/reindex`**

En el mismo archivo, el handler de `/reindex` queda:

```js
  router.all(
    '/reindex',
    requireKey,
    wrap(async (req, res) => {
      const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 500);
      const indexed = await backfillUnindexedPhotos(store, matcher, limit);
      const derivatives = await backfillPhotoDerivatives(store, matcher, limit);
      const pets = petStore ? await backfillUnindexedPetPhotos(petStore, petMatcher, limit) : null;
      res.json({ ...indexed, derivatives, pets });
    })
  );
```

- [ ] **Step 3: Pasar `petStore` y `petMatcher` desde `src/server.js`**

Cambiar:

```js
  app.use('/api', apiRoutes(store, faceMatcher));
```

por:

```js
  app.use('/api', apiRoutes(store, faceMatcher, petStore, petMatcher));
```

- [ ] **Step 4: Prueba directa del bloque nuevo**

Agregar al final de `test/pets.test.js`:

```js
test('GET /api/diag informa el estado del matching de mascotas', async (t) => {
  delete process.env.PET_MATCH_API_URL;
  const { server, base } = await startApp();
  t.after(() => server.close());
  const diag = await (await fetch(`${base}/api/diag`)).json();
  assert.equal(diag.pet_matching.api_url_present, false);
  assert.equal(diag.pet_matching.enabled, false);
});
```

Run: `npx node --test test/pets.test.js`
Expected: PASS (si algo falla acá, es que `petMatcher` no llegó hasta
`apiRoutes` — revisar el Step 3).

- [ ] **Step 5: Prueba directa de `/api/reindex` sobre una foto de mascota pendiente**

Agregar también a `test/pets.test.js`:

```js
test('/api/reindex recoge fotos de mascotas que quedaron sin embedding', async (t) => {
  delete process.env.PET_MATCH_API_URL;
  const { server, base } = await startApp();
  t.after(() => server.close());

  const fd = new FormData();
  fd.set('species', 'dog');
  fd.append('photos', new File([await photoBytes({ r: 3, g: 3, b: 3 })], 'p.jpg', { type: 'image/jpeg' }));
  fd.set('contact_phone', '300 000 0000');
  await fetch(`${base}/mascotas/reporte`, { method: 'POST', body: fd, redirect: 'manual' });

  // El matcher estaba apagado al reportar; ahora "vuelve" (mismo truco que ya
  // usa test/rescue.test.js: fakePetMatcher() pone la variable de entorno).
  const { fakePetMatcher } = require('./helpers');
  const pm = await fakePetMatcher();
  t.after(() => pm.stop());

  const res = await fetch(`${base}/api/reindex`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.pets.processed, 1);
});
```

Run: `npx node --test test/pets.test.js`
Expected: PASS.

- [ ] **Step 6: Correr la suite completa**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Documentar las variables de entorno nuevas**

Agregar al final de `.env.example` (sin leer el archivo completo — Read está
bloqueado por seguridad sobre `.env*`; usar `printf` para no arriesgar el
contenido existente):

```bash
printf '\n# Servicio de embeddings de mascotas (pet-matcher/) — opcional, sin ella el matching de mascotas queda apagado\nPET_MATCH_API_URL=\nPET_MATCH_THRESHOLD=80\n' >> .env.example
```

Y en `agent.md`, en la tabla de "Variables de entorno", agregar dos filas
(mismo formato que las demás):

```markdown
| `PET_MATCH_API_URL` | Matching de mascotas apagado; las fotos se guardan igual. Ver `pet-matcher/README.md`. |
| `PET_MATCH_THRESHOLD` | `80`. Sin calibrar todavía con fotos reales — ver el documento de diseño. |
```

- [ ] **Step 8: Commit**

```bash
git add src/routes/api.js src/server.js .env.example agent.md test/pets.test.js
git commit -m "Extiende /api/diag y /api/reindex, y documenta las variables de entorno del matching de mascotas"
```

---

### Task 10: Enlace en la navegación

**Files:**
- Modify: `src/html.js`

**Interfaces:** ninguna — cambio puramente visual.

- [ ] **Step 1: Prueba**

Agregar a `test/pets.test.js`:

```js
test('el sitio enlaza a mascotas desde la navegación', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());
  const html = await (await fetch(base)).text();
  assert.match(html, /href="\/mascotas"/);
});
```

Run: `npx node --test test/pets.test.js`
Expected: FAIL — el link todavía no existe.

- [ ] **Step 2: Agregar el link**

En `src/html.js`, dentro de `<nav>` (junto a los otros dos enlaces):

```html
  <nav>
    <a href="/mascotas">🐾 Mascotas</a>
    <a href="/rescate">Soy rescatista</a>
    <a href="/report" class="cta">Reporta desaparecido</a>
  </nav>
```

- [ ] **Step 3: Correr, confirmar que pasa**

Run: `npm test`
Expected: PASS — toda la suite, incluida la del sitio de personas (el nav es
compartido, así que cualquier prueba que cuente enlaces del header podría
verse afectada; si alguna falla por eso, es la señal de que ese conteo hay
que ajustarlo para incluir el nuevo link, no de que el link esté mal).

- [ ] **Step 4: Commit**

```bash
git add src/html.js test/pets.test.js
git commit -m "Enlaza la sección de mascotas desde la navegación del sitio"
```

---

## Verificación final

- [ ] `npm test` en verde de punta a punta.
- [ ] `cd pet-matcher && pytest -v` en verde.
- [ ] Verificación manual del Task 4 (modelo real) hecha al menos una vez y
  su resultado anotado (tamaño real del vector).
- [ ] Todo commiteado localmente — **nada de push ni de PR** hasta que el
  usuario lo revise y decida sobre la regla 3 de `CLAUDE.md`.
