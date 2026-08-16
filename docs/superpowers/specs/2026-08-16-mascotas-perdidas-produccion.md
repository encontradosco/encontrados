# Mascotas perdidas: qué falta para producción

Este documento junta lo que quedó pendiente después de implementar el plan
(`docs/superpowers/plans/2026-08-15-mascotas-perdidas.md`), pasar la revisión
final de toda la rama, y una sesión de pruebas manuales con fotos reales y una
comparación de 5 modelos candidatos. No es una lista de bugs — el código está
en verde (425/425 pruebas) y ya pasó una revisión de rama completa. Es la lista
de **decisiones e infraestructura** que faltan antes de que esto pueda vivir
en `main`.

## Estado actual

- Rama local `mascotas-perdidas`, 18 commits sobre el `main` en que se basó,
  ~4.300 líneas en 28 archivos. **No se ha hecho push ni abierto PR** — sigue
  todo local, por instrucción explícita.
- `npm test`: 425/425 en verde. `pet-matcher` (Python): 3/3 en verde con un
  embedding falso — el modelo real no se prueba en CI, a propósito (ver
  `pet-matcher/README.md`).
- Ya pasó: revisión por tarea (10 tareas + 2 rondas de arreglo) y una revisión
  final de toda la rama, que encontró y ya corrigió 1 hallazgo Critical y 7
  Important (todos mecánicos: privacidad de fotos, cobertura de Postgres,
  aislamiento de pruebas, límites de coincidencias, etc.).
- Ya se agregó en esta sesión, más allá del plan original: la página de
  listado público (`/mascotas`, espejo del listado de personas en `/`) —
  faltaba y ya está construida y probada.

---

## 1. Decisiones que le tocan a una persona (regla 3 de `CLAUDE.md`)

Nada de esto lo puede decidir un agente — son cambios de comportamiento de
usuario, esquema o privacidad. Cada uno con la evidencia que ya se juntó:

### 1.1 Elegir el modelo de embeddings

El modelo que quedó integrado en el plan original (`CLIP-ViT-base`) resultó
ser, con datos reales, **el peor de 5 candidatos evaluados**:

| Modelo | AUC promedio (perros+gatos, 160 mascotas reales) |
|---|---|
| Zer0int-CLIP-L | 99.03% — el mejor |
| DINOv2-small | 98.66% |
| SigLIP2-Base | 98.66% |
| SigLIP-Base | 98.33% |
| **CLIP-ViT-base (el que está integrado hoy)** | **97.72% — el peor** |

Dos candidatos razonables, con trade-offs distintos (medidos en esta máquina,
CPU, sin GPU):

- **DINOv2-small** — casi el mismo desempeño que el mejor, con **9× menos
  parámetros** que el actual (22M vs. 151M): 84 MB en disco, 373 MB de
  memoria, 27 ms por foto. Reduce el costo de infraestructura respecto a lo
  que ya está integrado.
- **Zer0int-CLIP-L** — el más preciso, a costa de ~3× más memoria (1.46 GB) y
  ~7× más lento por foto (197 ms) que el actual.

Cambiar el modelo es mecánico (cambiar `MODEL_NAME` y el método de extracción
del embedding en `pet-matcher/model.py`) pero **cambia directamente qué tan
seguido se le muestra el contacto de una familia a un desconocido** — de ahí
que sea una decisión de regla 3, no un detalle de implementación.

### 1.2 Calibrar `PET_MATCH_THRESHOLD`

Hoy vale `80` en el código, marcado desde el diseño original como "sin
calibrar". Ya hay evidencia concreta de que no es un número seguro tal cual:

- Con 5 fotos reales de celular (sin recortar), dos mascotas **distintas**
  confirmadas coincidieron al **80.8%** — por encima del umbral actual.
- Con el dataset grande (fotos más "limpias", recortadas a la cara), al 80%
  se **pierden entre el 11% y el 41% de las coincidencias reales**, según
  modelo y especie — ahí el problema no son los falsos positivos (esos ya
  eran raros, 0.4%–1.8%), es que el umbral parece demasiado alto.

La contradicción entre esos dos hallazgos importa: el número correcto de
umbral depende de qué tan "sucia" venga la foto real que suba una familia, y
eso solo se puede afinar con más fotos reales, no con un dataset académico
solo. **No calibrar esto no es una opción** — hay que decidir un número (o un
proceso para llegar a uno) antes de desplegar.

### 1.3 Ruta de borrado de un reporte de mascota

No existe. `markPetResolved` es la única operación de ciclo de vida — no hay
`deletePet` ni endpoint equivalente a `DELETE /api/people/:id`. Mientras
tanto, `/privacidad` no menciona mascotas en absoluto, y esta funcionalidad ya
agrega una clase nueva de dato personal guardado (contacto de quien reporta) y
una foto que sí se publica. Ley 1581 + regla 3, directo — hace falta decidir
el mecanismo de borrado y actualizar la política pública antes de que esto sea
público.

### 1.4 El flujo de "encontré" promete algo que hoy no puede cumplir

El link de navegación a `/mascotas` ya está visible para cualquier visitante
del sitio. La página de reporte dice explícitamente: *"Cuando alguien que
encontró una mascota parecida la compare, verá tu contacto y podrá
avisarte."* Pero mientras `pet-matcher` no esté desplegado en ningún lado
(`PET_MATCH_API_URL` sin configurar en producción), `/mascotas/encontre`
responde siempre "no está disponible" — la promesa no se cumple. Decidir si
se oculta el enlace/la funcionalidad hasta tener el servicio desplegado, o si
se despliega primero y se habilita después.

### 1.5 "Marcar como encontrada" no pide ninguna confirmación

`POST /mascota/:id/encontrado` no tiene token ni verificación — cualquier
visitante puede marcar la mascota de otra persona como encontrada, sin
posibilidad de deshacerlo. El flujo de personas deliberadamente NO hace esto
(un avistamiento sin verificar no puede sacar a nadie del listado). Decidir si
esto se queda así (bajo riesgo: solo cambia una etiqueta, no borra nada) o se
le agrega alguna verificación.

### 1.6 La pregunta de fondo: ¿"encontré" debería guardar algo?

La revisión final de la rama señaló que, como hoy no se captura ningún
contacto de quien "encontró" una mascota, la foto de esa búsqueda no tiene
ningún uso visible una vez comparada — nadie puede avisarle después si un
reporte llega más tarde. Guardar solo el embedding (para esa retroalimentación
futura) es lo que generó, en esta sesión, la clase de bug que se corrigió dos
veces (contenido no borrado en ciertos caminos). La alternativa — que
"encontré" sea **solo-búsqueda**, sin guardar nada, mismo patrón que ya existe
para personas vía `searchOnly` en `/rescate` — eliminaría esa clase de bug de
raíz, a cambio de la funcionalidad de aviso retroactivo (que hoy tampoco
existe, porque no se captura contacto). Vale la pena esta conversación antes
de invertir en desplegar la versión actual.

### 1.7 ¿Hace falta un listado de mascotas ya encontradas/resueltas?

Ya se agregó el listado de mascotas **perdidas** (`/mascotas`, espejo del de
personas). No existe un listado separado de las ya reencontradas — el
contador "🎉 N reencontradas" ya aparece, pero no hay dónde ver cuáles. El
lado de personas tampoco tiene esa página, así que esto es consistente con
"misma estructura" — se menciona acá solo para que la decisión de agregarlo
(o no) sea explícita, no un olvido.

---

## 2. Infraestructura nueva a desplegar

### 2.1 `pet-matcher/` necesita un host propio

No es serverless-compatible tal cual (el modelo se carga una vez al arrancar
y se queda en memoria) — necesita un proceso que se mantenga vivo: Fly.io,
Render o Railway son los candidatos ya evaluados en el diseño original.

- **Tier de memoria**, según el modelo elegido (1.1): ~512 MB–1 GB para
  DINOv2-small, ~2 GB para Zer0int-CLIP-L.
- **Cachear los pesos del modelo entre reinicios** — si el contenedor se
  reconstruye desde cero en cada despliegue, se re-descarga de HuggingFace
  cada vez (84 MB–1.6 GB según el modelo). Hornear los pesos en la imagen de
  Docker, o montarlos en un volumen persistente.
- **Autenticación** — hoy no tiene ninguna (decisión explícita, documentada en
  `pet-matcher/README.md`). **No exponerlo a internet sin agregar un secreto
  compartido primero**, mismo patrón que `WHATSAPP_RELAY_SECRET`. Esto incluye
  un cambio pequeño en `src/petfaces.js` (el cliente Node) para mandar el
  header con el secreto.
- **Concurrencia** — el servidor de desarrollo de Flask atiende una petición a
  la vez. Para producción hace falta `gunicorn` con varios workers, y **cada
  worker carga su propia copia del modelo en memoria** — la memoria total se
  multiplica por la cantidad de workers, hay que decidir cuántos según el
  tráfico esperado.

### 2.2 Variables de entorno nuevas en Vercel

| Variable | Valor |
|---|---|
| `PET_MATCH_API_URL` | La URL del `pet-matcher` ya desplegado (2.1). Sin ella, el matching de mascotas queda apagado — las fotos se guardan igual. |
| `PET_MATCH_THRESHOLD` | El número que salga de la decisión 1.2. Por ahora usa el default del código (`80`), sin calibrar. |

Si se agrega autenticación al servicio (2.1), hace falta una tercera variable
para el secreto compartido — no existe todavía en el código.

---

## 3. Cómo partir esto en PRs (regla 2 del repo)

La revisión final de la rama notó que el cambio completo (~4.300 líneas, 28
archivos) es demasiado grande para un solo PR bajo la convención de este
repo ("un PR = una preocupación"). División sugerida, cada una revisable por
separado:

1. **Esquema + servicio Python**, sin ninguna ruta web todavía: las tres
   tablas nuevas en los dos adaptadores, `pet-matcher/`, `src/pets.js`,
   `src/petfaces.js`, `src/petmatch.js`. No cambia nada que un usuario vea.
2. **Las páginas web**: `src/routes/pets.js`, el nav, el listado. Este PR sí
   cae en regla 3 (comportamiento de usuario) — se declara y espera a una
   persona.
3. **Diagnóstico y documentación**: `/api/diag`, `/api/reindex`,
   `.env.example`, `agent.md`.

Cada PR necesita su propia rama fresca desde el `main` real al momento de
abrirlo — no desde este branch acumulado.

---

## 4. Checklist antes de desplegar

- [ ] Decisión 1.1 (modelo) tomada y aplicada en `pet-matcher/model.py`.
- [ ] Decisión 1.2 (umbral) tomada y aplicada en `PET_MATCH_THRESHOLD`.
- [ ] Decisión 1.3 (borrado) resuelta: endpoint + texto de `/privacidad`.
- [ ] Decisión 1.4 (promesa sin servicio desplegado) resuelta.
- [ ] Decisión 1.5 (confirmación al marcar encontrada) resuelta o descartada explícitamente.
- [ ] Decisión 1.6 (¿solo-búsqueda?) conversada, aunque la respuesta sea "no, seguimos como está".
- [ ] `pet-matcher` desplegado, con autenticación (2.1), en un host que mantenga el proceso vivo.
- [ ] Variables de entorno (2.2) configuradas en Vercel.
- [ ] Rama partida en PRs chicos (sección 3), cada uno con su propia revisión.
- [ ] Smoke test contra el `pet-matcher` real ya desplegado (no `localhost`) — confirmar que el timeout de 15s en `src/petfaces.js` alcanza con latencia de red real, no solo en loopback.
- [ ] `npm test` y `pytest` en verde en la rama final de cada PR.
