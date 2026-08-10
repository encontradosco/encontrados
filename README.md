# 📍 Aquí — aqui.online

Tablero de estado de personas en emergencias. Dos casos de uso:

1. **Reportar** el estado de una persona (a salvo, herida, desaparecida…).
2. **Consultar** el estado de una persona y **suscribirse** a sus novedades.

Canales:

| Canal | Reportar | Consultar | Suscribirse |
|---|---|---|---|
| Web | ✅ | ✅ | ✅ (correo) |
| WhatsApp | ✅ | ✅ | ✅ (al número que escribe) |
| API REST | ✅ | ✅ | ✅ |
| Telegram | ✅ (listo, opcional) | ✅ | ✅ (al chat) |

Toda la interfaz es en español. El bot entiende comandos en español e inglés y siempre responde en español.

## Búsqueda de nombres (matching difuso)

No hace falta escribir el nombre exacto. Tres capas:

1. **Normalización** (al escribir): se guarda `full_name`, `normalized_name` (minúsculas, sin acentos ni puntuación, sin partículas "de/del/la") y `phonetic_name` (clave fonética por palabra afinada al español: b=v, s=z=c suave, ll=y, h muda, qu=k, j=g suave).
2. **Candidatos** (al consultar): en Postgres, índice trigram `pg_trgm` sobre las columnas normalizada y fonética. En SQLite (dev), escaneo directo.
3. **Puntaje por tokens** (JS, compartido): cada palabra de la consulta debe encontrar pareja en el candidato — en cualquier orden — por igualdad ≻ fonética ≻ prefijo ≻ distancia de edición ≤2. Así "Juan Pérez" encuentra a "Juan Carlos Pérez Gómez", tolera apellidos invertidos y typos.
   - **≥ 0.85** al reportar → se considera la misma persona (los reportes se unen en una sola línea de tiempo).
   - **0.55–0.85** al buscar → se muestran como resultados ordenados; ante ambigüedad se listan opciones, nunca se adivina.

Punto de extensión: `candidatePeople()` en los adaptadores de storage es donde se puede sumar un generador de candidatos por *embeddings* (pgvector en Neon) si más adelante se quiere equivalencia de apodos/idiomas (Bill↔Guillermo).

## Ubicación

Cada reporte lleva `location` opcional (texto libre). La página de la persona muestra la **última ubicación reportada**; el bot acepta `@`:

```
BIEN Juan Pérez: hablé con él @ albergue San José
```

## Correr local

```bash
npm install
npm run dev     # SQLite en ./data/aqui.db, http://localhost:3000
npm test
```

## Deploy en Vercel

1. Importa el repo en Vercel (framework: **Other**). `vercel.json` enruta todo a la función `api/index.js` (Express completo); `/public` lo sirve el CDN.
2. Agrega **Vercel Postgres / Neon** al proyecto → define `POSTGRES_URL` (o `DATABASE_URL`). El esquema y los índices `pg_trgm` se crean solos en el primer arranque.
3. Variables de entorno (ver `.env.example`): `BASE_URL`, `SENDGRID_API_KEY` (el remitente es fijo: `a@torrenegra.com`), `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, opcional `TELEGRAM_BOT_TOKEN`, opcional `API_KEY`.

### WhatsApp (Meta Cloud API)

1. En [Meta for Developers](https://developers.facebook.com), crea una app con el producto WhatsApp y toma `WHATSAPP_TOKEN` y `WHATSAPP_PHONE_NUMBER_ID`.
2. Configura el webhook: URL `https://aqui.online/webhooks/whatsapp`, verify token = `WHATSAPP_VERIFY_TOKEN`, suscrito al campo `messages`.
3. Comandos: `AYUDA`, `BUSCAR <nombre>`, `BIEN|HERIDO|DESAPARECIDO <nombre>: <nota> @ <lugar>`, `SUSCRIBIR <nombre>`, `BAJA <nombre>` / `BAJA TODO`. Un mensaje sin comando se trata como búsqueda.

### Telegram (opcional)

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://aqui.online/webhooks/telegram"
```

## API

Lecturas públicas; si defines `API_KEY`, los POST requieren `Authorization: Bearer <API_KEY>`.

```bash
# Reportar (crea la persona si no existe; matching difuso para no duplicar)
curl -X POST https://aqui.online/api/updates \
  -H 'Content-Type: application/json' \
  -d '{"name":"Juan Pérez","status":"safe","message":"Confirmado por teléfono","location":"Albergue San José","reporter":"María"}'

# Buscar (tolera typos, acentos, nombres incompletos)
curl 'https://aqui.online/api/people?q=jaun%20peres'

# Detalle + historial
curl https://aqui.online/api/people/1

# Suscribir
curl -X POST https://aqui.online/api/people/1/subscriptions \
  -H 'Content-Type: application/json' \
  -d '{"channel":"email","address":"familia@ejemplo.com"}'
```

`status` ∈ `safe | injured | missing | deceased | unknown`.

## Arquitectura

```
src/
  names.js        # normalización, clave fonética, puntaje difuso
  people.js       # lógica compartida (búsqueda, merge de personas, suscripciones)
  store/          # adaptadores: postgres.js (prod/Vercel), sqlite.js (dev/tests)
  bot.js          # motor conversacional compartido (WhatsApp + Telegram)
  notify.js       # salidas: SendGrid, WhatsApp Cloud API, Telegram
  routes/         # web (HTML servido del servidor), api (JSON), webhooks
api/index.js      # entry point serverless para Vercel
```

Al llegar un reporte nuevo se notifica a todos los suscriptores de esa persona (correo, WhatsApp y/o Telegram), excepto a quien reportó.
