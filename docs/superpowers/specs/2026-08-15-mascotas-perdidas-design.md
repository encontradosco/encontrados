# Mascotas perdidas: buscarlas por foto

**Estado:** propuesto, sin construir. Cae en dos de las tres categorías de la
regla 3 de `CLAUDE.md` (lo que ve/hace un usuario, y el esquema de la base) —
**no se mergea sin que lo decida una persona.** Este documento se queda local
hasta que el usuario lo revise.

## Contexto y objetivo

encontrados.co conecta a quien rescata a una PERSONA con quien la busca, vía
reconocimiento facial (AWS Rekognition). La pregunta que originó esto: ¿se
puede hacer lo mismo para mascotas perdidas después del terremoto?

Conclusión de la investigación previa: Rekognition no reconoce caras de
animales — no es un flag que se prenda. La opción elegida, tras comparar
alternativas, es un modelo abierto de embeddings (`AvitoTech/CLIP-ViT-base-for-
animal-identification`, Apache 2.0, entrenado para distinguir individuos de
perros y gatos) corriendo en un servicio propio en Python, en vez de una API
externa de pago o de reconstruir el reconocimiento facial de personas para
animales.

## Alcance de esta versión

**Entra:**
- Reportar una mascota perdida (foto se guarda y se publica).
- Buscar si una mascota encontrada coincide con algún reporte (foto se
  compara, no se guarda — igual que un rescatista).
- Perros y gatos únicamente.
- El servicio Python corre local, sin autenticación (decisión explícita del
  usuario: "por ahora no autenticación, lo corro local y luego despliego").

**No entra en esta versión (declarado, no un olvido):**
- Avisar a quien encontró una mascota si un reporte aparece DESPUÉS de su
  búsqueda (el equivalente a que un rescatista deje su contacto en
  `/rescate`). Requiere `pet_subscriptions` con contacto — se deja el esquema
  listo, pero el flujo de notificación de esa dirección no se construye ahora.
- API JSON pública para mascotas (`/api/pets`). Solo interfaz web.
- Autenticación del servicio Python (se agrega antes de desplegarlo en
  público — ver "Pendiente antes de producción").
- Panel de estadísticas (`/admin/stats`) no gana ninguna cifra de mascotas en
  esta versión.

## Corrección sobre lo discutido en el chat

Antes de escribir esto había propuesto que el cálculo del embedding corriera
siempre en un barrido asíncrono, por si la latencia de un proveedor externo
era impredecible. Como el servicio Python es propio y se mantiene corriendo
con el modelo ya cargado en memoria (no serverless, no llamada a un tercero),
no hay razón para no espejar exactamente cómo se hace con Rekognition hoy:
**la llamada es síncrona**, dentro del mismo request que sube la foto —
`processPhoto`/`identifyRescuedPerson` hacen lo mismo con Rekognition ahora
mismo. El barrido asíncrono (`backfillUnindexedPetPhotos`) sigue existiendo,
pero solo como red de seguridad para cuando el servicio estuvo caído al
momento de subir la foto — el mismo rol que `backfillUnindexedPhotos` cumple
hoy, no el camino principal.

## Datos — tablas nuevas, ningún cambio a las de personas

Dos tablas, en los dos adaptadores (`src/store/postgres.js` y
`src/store/sqlite.js`). Los enums quedan en inglés como el resto del esquema
(`kind IN ('report','query')` ya existe así); lo que ve un usuario se traduce
solo en el HTML, nunca en la base.

```sql
CREATE TABLE IF NOT EXISTS pets (
  id SERIAL PRIMARY KEY,               -- INTEGER PRIMARY KEY AUTOINCREMENT en SQLite
  species TEXT NOT NULL CHECK (species IN ('dog','cat')),
  pet_name TEXT,
  description TEXT,                    -- color, tamaño, señas — texto libre
  contact TEXT,                        -- de quien reporta; NUNCA sale público
  resolved_at TIMESTAMPTZ,              -- lo marca el dueño cuando ya apareció
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pet_photos (
  id SERIAL PRIMARY KEY,
  pet_id INTEGER REFERENCES pets(id) ON DELETE CASCADE,   -- NULL si kind='query'
  kind TEXT NOT NULL CHECK (kind IN ('report','query')),
  subscription_id INTEGER REFERENCES pet_subscriptions(id) ON DELETE CASCADE,
  content BYTEA,                        -- NULL/borrado si kind='query' tras comparar
  content_type TEXT NOT NULL,
  embedding JSONB,                      -- vector de 512 floats
  embedding_model TEXT,                 -- ej. 'avitotech/clip-vit-base-for-animal-identification'
  thumb BYTEA,
  thumb_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pet_photos_pet ON pet_photos(pet_id);

CREATE TABLE IF NOT EXISTS pet_subscriptions (
  id SERIAL PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('email','whatsapp')),
  address TEXT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT false,
  verify_token TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Por qué son tablas nuevas y no una columna `species` en `people`/`photos`:
esas tablas están afinadas para personas (nombre, timeline de `updates`,
`rescue_state`…) y este repo ya advierte en `agent.md` sobre lo delicado que
es tocarlas. Una mascota no necesita timeline de estados en esta versión —
`resolved_at` basta.

Por qué `pet_id` es nullable en `pet_photos`: a diferencia de una persona
rescatada (que ancla su foto a una "persona placeholder", ver
`RESCUE_ANCHOR_PREFIX` en `src/people.js`), quien encuentra una mascota no
necesita una fila ancla — no hay timeline ni notificación por esa fila en
esta versión, así que no hay nada que colgarle. Si la fase 2 agrega "avísame
si aparece el dueño", ahí sí se decide si hace falta una ancla o si
`subscription_id` solo (sin `pet_id`) alcanza.

`embedding_model` importa por la misma razón que `FACE_COLLECTION_ID` no se
renombra a la ligera: si el modelo cambia de versión, un embedding viejo no
es comparable con uno nuevo con el mismo umbral. Guardar qué modelo lo
produjo es lo mínimo para no comparar peras con manzanas en silencio el día
que eso pase.

## El servicio de embeddings — `pet-matcher/`, Python, sin autenticación

Carpeta nueva en la raíz del repo, **fuera de `api/`** para que Vercel no la
detecte como una función Python (el `functions` de `vercel.json` ya apunta
solo a `api/index.js`, pero conviene no tentar el auto-detect con un
`requirements.txt` donde Vercel lo busca por convención).

```
pet-matcher/
  app.py          # servidor HTTP (Flask), un solo proceso, un solo endpoint
  model.py        # carga el modelo UNA vez al arrancar, no por request
  requirements.txt
  test_app.py     # pytest — no corre dentro de npm test
  README.md       # cómo levantarlo local: pip install, cómo correrlo
```

Contrato único: `POST /embed`, recibe la imagen (multipart), responde:

```json
{ "embedding": [0.0123, -0.045, "...512 floats"], "model": "avitotech/clip-vit-base-for-animal-identification" }
```

Sin autenticación por ahora (decisión explícita, ver arriba). Sin
comparación ni almacenamiento — esa lógica y las reglas de privacidad se
quedan en el lado Node, igual que hoy Rekognition solo compara y el resto de
las reglas viven en `facematch.js`. Nota real: a diferencia de Rekognition,
este modelo no valida "¿hay un animal en la foto?" — siempre devuelve un
vector. La revisión humana en la lista pública sigue siendo la única
verificación de que la foto corresponde a lo que dice.

## Lado Node — `src/petfaces.js` + `src/petmatch.js`

**`src/petfaces.js`** (espejo de `src/faces.js`):

```js
// enabled: true solo si PET_MATCH_API_URL está puesta.
// embed(bytes) → { embedding, model } o null si el servicio no responde.
// Nunca lanza: un servicio caído apaga el matching, no tumba el reporte.
```

Sin `PET_MATCH_API_URL` configurada → deshabilitado, igual que sin
credenciales de AWS: la foto se guarda, no se compara, y
`backfillUnindexedPetPhotos` la recoge cuando el servicio vuelva.

**`src/petmatch.js`** (espejo de `src/facematch.js`):

- `processPetPhoto(store, petFaces, { petId, kind, subscriptionId, bytes, contentType })`
  — guarda la foto, pide el embedding, guarda el vector, compara contra el
  lado opuesto (`report` ⟷ `query`) **filtrando por la misma especie** —
  nunca cruza perro con gato.
- La similitud (coseno) se calcula en JS sobre los embeddings guardados —
  sin "colección" administrada como la de Rekognition, pero a este volumen
  (cientos, no millones, de mascotas) no hace falta más.
- Umbral: `PET_MATCH_THRESHOLD` (env var, sin calibrar todavía — se prueba
  con fotos reales antes de confiar en un número).
- Al encontrar coincidencia: reusa `notify.js` y el modo `relay` **tal
  cual** — el contacto de quien reporta no viaja solo a un desconocido, por
  la misma razón que ya existe para personas (el cuento de "encontré a tu
  perro, mándame para la gasolina" es una estafa real y común).
- `backfillUnindexedPetPhotos(store, petFaces, limit)` — mismo rol que
  `backfillUnindexedPhotos`: red de seguridad, no camino principal.

## Rutas y páginas — `src/routes/pets.js` (archivo nuevo)

`web.js` ya es "el archivo más grande del repo" según `agent.md`; las
páginas de mascotas van en su propio router, montado en `src/server.js`
junto a los demás.

- `GET /mascotas` — landing con las dos acciones.
- `GET+POST /mascotas/reporte` — reportar mascota perdida (foto se guarda,
  1–3 fotos, mismo tope conceptual que personas).
- `GET+POST /mascotas/encontre` — reportar mascota encontrada (foto se
  compara en el momento, resultado en pantalla, foto no se guarda).
- `GET /mascota/:id` — ficha pública de un reporte.
- `GET /pet-photo/:id{,/thumb}` — solo sirve fotos `kind='report'`.

Todo el texto de estas páginas en español, mismo estilo (`layout()`, `esc()`)
que el resto del sitio.

## Diagnóstico

`GET /api/diag` gana un bloque `pet_matching` (URL configurada o no, último
chequeo — mismo espíritu que el bloque `notifications` de hoy: nunca un
secreto, solo presencia y estado).

## Variables de entorno nuevas

| Variable | Si falta |
|---|---|
| `PET_MATCH_API_URL` | Matching de mascotas apagado; fotos se guardan igual. |
| `PET_MATCH_THRESHOLD` | Se define un default explícito en el código, marcado como sin calibrar. |

Ninguna es obligatoria — mismo principio que el resto del repo: todo se
degrada solo.

## Pruebas

- `npm test` nunca necesita Python corriendo: un servidor HTTP falso local
  hace de doble para `pet-matcher`, mismo patrón que `test/helpers.js` ya
  usa para SendGrid y GitHub.
- `pet-matcher/test_app.py` (pytest) prueba el servicio Python por su cuenta
  — no se integra a `.github/workflows/ci.yml` en esta versión; correrlo es
  manual hasta que el usuario decida desplegarlo.

## Pendiente antes de producción (declarado, no resuelto acá)

- Autenticación del servicio Python (secreto compartido, mismo patrón que
  `WHATSAPP_RELAY_SECRET`) — el usuario ya dijo que esto es para después.
  **No desplegar `pet-matcher` accesible desde internet sin esto.**
  Cualquiera podría gastarle cómputo al servidor gratis.
- Dónde vive en producción: necesita un proceso que se quede vivo (no
  serverless) para no recargar el modelo en cada arranque — a decidir
  cuándo el usuario despliegue.
- Calibrar `PET_MATCH_THRESHOLD` con fotos reales.
- Confirmar con una persona que este documento cae correctamente en la
  regla 3 antes de construir nada de esto en una rama que vaya a `main`.
