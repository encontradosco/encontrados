# 📍 encontrados.co

Conecta a quien **rescata** a una persona con quien la **busca** — tras el terremoto en Colombia del lunes 10 de agosto.

1. **Rescatista** (voluntario, bombero, policía, hospital): sube la foto de la persona que tiene consigo. Se compara por reconocimiento facial contra los reportes de desaparecidos y se le muestra **quién la busca y cómo contactarlo**. La foto **se borra de inmediato**: solo queda su firma facial, para poder avisarle si alguien la busca más tarde. Puede registrar un aviso por correo.
2. **Familia**: reporta a una persona desaparecida con 1–3 fotos, nombre, el lugar donde cree que estaba y su teléfono o correo de contacto. No registra alertas ni ve resultados de búsqueda.

El contacto de quien reporta **solo** se revela a un rescatista cuando el rostro coincide; nunca aparece en páginas públicas. Ninguna ruta del sitio sirve bytes de fotos.

Diseño ultraliviano a propósito: HTML renderizado en el servidor, un CSS pequeño, sin frameworks — funciona en teléfonos viejos y conexiones débiles.

## Correr local

```bash
npm install
npm run dev     # SQLite en ./data/aqui.db, http://localhost:3000
npm test
```

## Deploy en Vercel

1. Importa el repo en Vercel (framework: **Other**). `vercel.json` enruta todo a la función `api/index.js` (Express completo); `/public` lo sirve el CDN.
2. Agrega **Vercel Postgres / Neon** al proyecto → define `POSTGRES_URL` (o `DATABASE_URL`). El esquema y los índices `pg_trgm` se crean solos en el primer arranque.
3. Variables de entorno (ver `.env.example`): `BASE_URL`, `SENDGRID_API_KEY` (remitente fijo: `a@torrenegra.com`), `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION` (Rekognition), y cuando haya credenciales de WhatsApp: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`. Opcional: `API_KEY`.

### WhatsApp (Meta Cloud API) — pendiente de credenciales; el canal está implementado pero sin referencias en la interfaz hasta activarlo

1. En [Meta for Developers](https://developers.facebook.com), crea una app con el producto WhatsApp y toma `WHATSAPP_TOKEN` y `WHATSAPP_PHONE_NUMBER_ID`.
2. Configura el webhook: URL `https://encontrados.co/webhooks/whatsapp`, verify token = `WHATSAPP_VERIFY_TOKEN`, suscrito al campo `messages`.
3. Comandos: `AYUDA`, `BUSCAR <nombre>`, `BIEN|HERIDO|DESAPARECIDO <nombre>: <nota> @ <lugar>`, `SUSCRIBIR <nombre>`, `BAJA <nombre>` / `BAJA TODO`. Un mensaje sin comando se trata como búsqueda.

## API

Lecturas públicas; si defines `API_KEY`, los POST requieren `Authorization: Bearer <API_KEY>`.

```bash
# Reportar (crea la persona si no existe; matching difuso para no duplicar)
curl -X POST https://encontrados.co/api/updates \
  -H 'Content-Type: application/json' \
  -d '{"name":"Juan Pérez","status":"safe","message":"Confirmado por teléfono","location":"Albergue San José","reporter":"María"}'

# Buscar (tolera typos, acentos, nombres incompletos)
curl 'https://encontrados.co/api/people?q=jaun%20peres'

# Detalle + historial
curl https://encontrados.co/api/people/1

# Suscribir
curl -X POST https://encontrados.co/api/people/1/subscriptions \
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
  bot.js          # motor conversacional (WhatsApp)
  notify.js       # salidas: SendGrid, WhatsApp Cloud API
  routes/         # web (HTML servido del servidor), api (JSON), webhooks
api/index.js      # entry point serverless para Vercel
```

Al llegar un reporte nuevo se notifica a todos los suscriptores **verificados** de esa persona (correo y/o WhatsApp), excepto a quien reportó.

## Suscripciones: verificación y baja

- **Correo**: la suscripción nace sin verificar; se envía un correo con enlace `/verify?token=…`. No se manda ninguna alerta hasta confirmar.
- **WhatsApp**: verificadas implícitamente (la persona escribe desde su propio número).
- **Baja**: toda alerta (correo y WhatsApp) incluye un enlace personal `/unsubscribe?token=…` de un clic. En el bot también funciona `BAJA <nombre>` / `BAJA TODO`.
