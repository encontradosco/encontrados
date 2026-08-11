# Instrucciones para agentes (AI y humanos)

## Regla principal: SIEMPRE publicar a producción

**Todo cambio debe quedar en producción inmediatamente.** Después de cualquier
modificación al código:

1. Corre las pruebas: `npm test` (deben quedar en verde).
2. Haz commit con mensaje claro y push a la rama de trabajo.
3. **Lleva el cambio a `main` de inmediato** (merge del PR, o push directo a
   `main` si no hay PR). Vercel despliega `main` a producción automáticamente.
4. No dejes trabajo "pendiente de deploy": si está en `main`, está vivo; si no
   está en `main`, no existe.

Este es un servicio de emergencias: un cambio útil que no está publicado no
ayuda a nadie.

## Contexto del proyecto

- **encontrados.co**: conecta a quien RESCATA a una persona con quien la BUSCA.
  - Rescatista: sube una foto de la persona que tiene al lado → reconocimiento
    facial → ve quién la busca y su contacto. La foto NUNCA se guarda: se borra
    tras indexar su firma facial. Solo los rescatistas pueden registrar avisos.
  - Familia: reporta un desaparecido (1–3 fotos, nombre, lugar, contacto).
    NO puede registrar alertas ni ver resultados de búsqueda.
  - El contacto de quien reporta solo se muestra a un rescatista tras una
    coincidencia facial; nunca en páginas públicas.
- Toda la interfaz y los mensajes al usuario son **en español**.
- Canales activos: web y API REST. WhatsApp está implementado pero dormido (sin credenciales aún) — no mostrar referencias a WhatsApp en la interfaz hasta que se active. (Telegram fue retirado.)
- Fotos — dos reglas distintas según quién las sube:
  - **Rescatista** (`kind='query'`): la foto NUNCA se guarda ni se muestra. Se
    compara, se indexa su firma facial y los bytes se borran de inmediato. Solo
    sobreviven los metadatos faciales.
  - **Reporte de desaparecido** (`kind='report'`): la foto SÍ se guarda y SÍ se
    publica, en la lista de personas desaparecidas, con los puntos de detección
    facial dibujados encima (`facePlate()` en `src/html.js`). Es el propósito
    del reporte: que un rescatista reconozca a la persona.
  - `GET /photo/:id` (foto completa) y `GET /photo/:id/thumb` (miniatura del
    rostro) sirven únicamente fotos `kind='report'`. Nunca ampliarlos a fotos
    de rescatistas.
- La lista pública NUNCA carga la foto completa: usa la miniatura cuadrada de
  240px recortada sobre el rostro (`src/thumbs.js`), ~3 KB en vez de cientos.
  Y ni siquiera esa se descarga sola si la conexión es mala: la regla vive en
  `thumbnailsAreAffordable()` (`src/html.js`), que se testea en Node y se
  manda al navegador con `toString()` — hay una sola copia, no la dupliques.
  En 2G, 3G lento o con ahorro de datos se muestra un botón «Ver foto» y la
  decisión es del visitante. Mucha gente consulta esto con una barra de señal.
- `POST /api/reindex` es idempotente y pone al día las fotos ya guardadas
  (miniatura + geometría). La geometría de una foto ya indexada se saca con
  `DetectFaces`, nunca con `IndexFaces`: reindexarla duplicaría el rostro en
  la colección.
- Producción: Vercel (función serverless única + Postgres/Neon). Dev/tests: SQLite.
- Remitente de correo fijo: `a@torrenegra.com` (SendGrid).
- Suscripciones por correo requieren verificación; toda alerta lleva enlace de baja.
- El matching difuso de nombres vive en `src/names.js` + `people.js`; los umbrales
  (0.85 merge / 0.55 búsqueda) están calibrados — no los cambies sin pruebas.
