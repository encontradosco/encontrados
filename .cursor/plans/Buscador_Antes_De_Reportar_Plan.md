# Spike: buscador de personas antes de reportar

## Objective

Permitir a quien busca a un familiar **consultar si ya está en el sistema** (reportado o reencontrado) **antes** de llenar `/report`, para no crear un segundo reporte innecesario y para saber si ya hay novedad.

## Current problem

Hoy solo hay advertencia **después** de enviar el formulario: `src/duplicates.js` compara cara/nombre y avisa vía cookie `encontrados_dup` en la ficha de la persona (ver `src/routes/web.js`). Es advisory y no debe bloquear ni descartar reportes — en una emergencia el peor resultado es un reporte que el sistema tiró por creer que ya lo tenía.

La búsqueda previa **no existe en UI**. Sí existe la pieza de datos:

- `store.searchPeople()` — fuzzy por nombre
- `GET /api/people?q=` (`src/routes/api.js`) — resultados con último estado vía `publicUpdate()`

Eso alimenta integraciones (bot de WhatsApp, docs), no el flujo de `/report`.

Issue de origen: pedido de @yuryninog — distinto de la detección post-reporte; es poder buscar antes de reportar.

## Common Work

Independiente de la opción de UX:

- Reutilizar `GET /api/people?q=` / `searchPeople()` + `publicUpdate()` (sin exponer `contact`)
- Mantener la regla: **nunca bloquear ni descartar** un reporte por posible duplicado
- Textos en español, usable en móvil con mala señal (sin framework nuevo)
- Declarar en el PR: **cambia lo que ve / hace un usuario** — no lo mergea un agente; decide @ni500 o @torrenegra
- Tras elegir UX: pruebas sintéticas + revisión de privacidad en lo que se muestra al encontrar coincidencia

## Options

### Option A: Pantalla de búsqueda aparte, antes de `/report`

**Summary:** Paso previo (“¿Ya está reportada?”) → resultados → ir a ficha existente o continuar a `/report`.

**What changes if we choose this:**
- Nuevo punto de entrada desde home / botón “Reportar”
- Flujo más largo; la búsqueda es explícita

**Trade-offs:**
- Pros: intención clara; menos ruido en el formulario; fácil explicar “buscá primero”
- Cons: un paso más en emergencia; quien tiene prisa puede saltarlo (hay que decidir si es obligatorio u opcional)

### Option B: Autocompletar dentro de `/report`

**Summary:** Mientras escribe el nombre, se consultan coincidencias y se muestran inline.

**What changes if we choose this:**
- `/report` gana búsqueda en vivo; no hay pantalla nueva
- Hay que definir debounce, vacío, error de red y “seguir igual”

**Trade-offs:**
- Pros: menos fricción; quien ya iba a reportar ve el aviso en contexto
- Cons: más carga cognitiva en el formulario; riesgo de parecer que el sistema “impide” reportar; más JS en el cliente

### Decisión anidada (aplica a A y B): qué ofrecer al encontrar coincidencia

| Camino | Qué se ofrece |
|--------|----------------|
| **1. Solo informar** | Enlace a la ficha pública (estado, bitácora pública). Crear reporte nuevo sigue igual de fácil. |
| **2. Dirigir al existente** | CTA fuerte: “Agregar info / dejar contacto en este reporte” (`/report?name=…&desde=…` ya existe en parte). Crear uno nuevo queda como secundaria. |
| **3. Híbrido** | Si estado = reencontrada → enfatizar ficha; si sigue buscada → ofrecer suscripción/contacto en ese registro y “reportar de todas formas” visible. |

## Decision point

**Decisión tomada (2026-08-16):** Option **A opcional** + camino **3 (híbrido)**.
Pantalla `/buscar`, enlaces desde home y `/report` sin alargar el camino crítico.
CTAs por último estado público (ver `searchHitCard` / `test/buscar.test.js`):
- `safe` o `deceased` → ficha primero; secundaria «No es esta persona — reportar a otra»
- `injured` → ficha primero; secundaria «dejar mi contacto»
- `missing` / `unknown` → «dejar mi contacto» primero; ficha secundaria
- siempre, a nivel de página, queda «reportar de todas formas»

**Quién decide cambios posteriores:** mantenedor humano — @ni500 o @torrenegra.

**Qué quedó abierto (no bloquea A):**
- ¿Autocompletar en `/report` (Option B) como segundo PR si A demuestra uso?

**After the decision:**
- UI de `/buscar` sobre `searchPeople` / `GET /api/people?q=`
- Tests en `test/buscar.test.js`

## Recommendation

Empezar con **Option A opcional** (enlace claro desde home y desde `/report`: “Buscar si ya está reportada”) + **camino 3 (híbrido)**: si ya está reencontrada, la ficha es el destino principal; si sigue buscada, priorizar sumarse al reporte existente sin esconder “reportar de todas formas”. Evita alargar el camino crítico y no convierte la búsqueda en un semáforo que asuste a quien necesita crear el registro igual. El autocompletar (B) puede ser un segundo PR si A demuestra uso.
