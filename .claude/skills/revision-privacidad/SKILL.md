---
name: revision-privacidad
description: Revisar que un cambio de este repo no filtre datos personales — el contacto de una familia, una foto de rescatista, PII en logs, tests o fixtures — antes de abrir el PR. Úsala cuando el cambio toque respuestas públicas, fotos, correos o WhatsApp, la bitácora, plantillas HTML, o cuando alguien pregunte si algo se puede mostrar, guardar, registrar o enviar.
---

# Revisión de privacidad

Acá la privacidad no es un aviso legal al pie: es lo que gobierna el código.
Del otro lado hay familias buscando a alguien, y entregarle el contacto de una
familia a un desconocido que dice haber rescatado a una persona es un vector de
extorsión conocido. Esta revisión es para el diff, antes de mandarlo.

Si algo de acá falla, **no es un comentario de estilo**: es una de las tres
categorías donde la decisión la toma una persona (ver `/pr-chico`).

## Las cinco preguntas

### 1. ¿Algo sale a una respuesta pública sin pasar por la puerta?

`src/privacy.js` es **la única puerta** por la que una fila de `updates` sale a
una respuesta pública: `publicUpdate()` quita `contact` por construcción y
`maskReporter()` reduce `reporter` (un teléfono o un correo nunca salen
literales; se vuelven «Reporte ciudadano»).

Nunca devuelvas una fila cruda. Búscalo en el diff:

```bash
git diff origin/main -- src/ | rg -n 'res\.json|contact|reporter'
```

Cualquier `res.json` con datos de `updates` que no venga de `publicUpdate()` es
un hallazgo.

### 2. ¿El contacto viaja en un mensaje que sale?

**El contacto de una familia no viaja en ningún mensaje saliente.** Se le muestra
a un rescatista **en pantalla**, tras una coincidencia facial, y ahí termina.

Y ningún aviso a un tercero sale solo: `NOTIFY_MODE` es `relay` por omisión —
`notifySubscribers()` (`src/notify.js`) y `notifyFaceMatch()`
(`src/facematch.js`) se relevan a un buzón de operación para que una persona
verifique al destinatario. **La verificación de correo no se releva** (va al
dueño de la dirección, confirmando lo que él mismo pidió).

Dos trampas:

- El relevo vive en la **capa de notificación**, no dentro de `sendEmail()`. Si
  agregas un envío nuevo, tiene que respetar `NOTIFY_MODE` **explícitamente**; un
  interceptor global se llevaría también la verificación y el bug sería invisible.
- Un canal con plantillas aprobadas (WhatsApp) no acepta texto libre con
  contacto. Si el flujo necesita eso, se convierte en relevo al operador.

### 3. ¿Se respetan las dos reglas de fotos, que son opuestas a propósito?

- **Rescatista** (`kind='query'`): se compara, se indexa la firma facial y **los
  bytes se borran**. Nunca se guarda ni se muestra.
- **Reporte de desaparecido** (`kind='report'`): sí se guarda y **sí se publica**
  — es el propósito del reporte.

`GET /photo/:id` y `GET /photo/:id/thumb` sirven **únicamente** fotos
`kind='report'`. Ampliar eso a fotos de rescatista es una filtración, aunque
compile y pase los tests.

### 4. ¿Hay PII en un log, en la bitácora, en el panel o en un error?

- Las tablas `match_log` y `contact_log` guardan **solo IDs y enums**. Ni un
  nombre, ni un contacto, ni un texto libre.
- `GET /admin/stats` muestra **solo cifras agregadas** — la misma clase de dato
  que ya es pública en `GET /api/diag`. Nunca un nombre, un contacto, un
  `person_id`, un `face_id` ni un `update_id`.
- `GET /api/diag` nunca muestra un secreto: de una credencial enseña largo y
  prefijo, nunca el valor.

```bash
git diff origin/main | rg -n 'console\.(log|warn|error)'
```

Revisa uno por uno qué se está imprimiendo. Un `console.log(row)` con una fila de
`updates` mete el contacto de una familia en los logs de producción.

### 5. ¿Hay datos de personas reales en el repo?

Ni en un test, ni en un fixture, ni en un pantallazo, ni en un comentario. Los
tests usan nombres sintéticos («Persona Prueba Uno», `familia@ejemplo.com`) a
propósito, y así se quedan. Esto incluye fotos, teléfonos, correos y documentos.

```bash
git diff origin/main | rg -n '[0-9]{7,}|[\w.+-]+@[\w-]+\.[\w.]+'
```

Todo lo que salga tiene que ser evidentemente inventado. Y credenciales, nunca:
variable nueva → `.env.example` con un valor de ejemplo.

## Dos más, si el cambio arma HTML o borra datos

- **Todo dato que venga de afuera pasa por `esc()`** (`src/html.js`). El HTML se
  arma concatenando strings: no hay nada más protegiéndolo.
- El borrado (`DELETE /api/people/:id`) cumple la promesa de la política de
  privacidad y la fila se va en cascada — pero **el rostro sigue en la colección
  de reconocimiento facial**. Si tu cambio toca borrado o retención, esa brecha
  es parte de lo que hay que decir en el PR.

## Cierre

Escribe en el cuerpo del PR, con esas palabras, qué de lo anterior tocaste y qué
verificaste. Si tocó privacidad: **lo decide una persona, no se mergea solo.**
