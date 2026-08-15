# Contexto para trabajar este repo con un agente

**encontrados.co** conecta a quien **rescata** a una persona con quien la
**busca**. Está en producción, salió del terremoto del 10 de agosto de 2026, y
del otro lado hay familias buscando a los suyos.

Este archivo lo carga Claude Code solo, al abrir el repo. Es el **enrutador y
las reglas que no se pueden ignorar**, no el manual: el manual es
[`agent.md`](agent.md) (mapa del código y sus trampas) y
[`CONTRIBUTING.md`](CONTRIBUTING.md) (cómo se manda un cambio). Están enlazados
abajo, en el momento en que hacen falta, para que no haya dos versiones de la
misma verdad.

---

## Las cuatro reglas

### 1. `main` es producción

Vercel despliega cada merge a `main`. **Mergear *es* desplegar**, en vivo, sin
ventana de staging. No hay forma de adivinarlo desde afuera, y es lo que más
caro sale ignorar. De este hecho salen las otras tres reglas.

`main` está protegida: todo entra por PR, con CI en verde y la aprobación de un
mantenedor distinto de quien lo escribió. No existe el push directo.

### 2. PRs pequeños sobre `main`

Rama fresca desde el `main` actual, **un PR = una preocupación**. Un PR acotado
se revisa y entra el mismo día; una rama grande de reconciliación compite con el
trabajo de los demás y se pudre — ya pasó una vez y esa rama se descartó.

Si arreglas el header y de paso renombras variables, son dos PRs.

### 3. Tres categorías donde decide una persona

Lo rutinario —**corrección de errores, texto y copy, refactors que no cambian
comportamiento observable, y documentación**— avanza con la revisión de un
mantenedor. En una emergencia, un arreglo no debería esperar a que coincidan dos
husos horarios.

Se detiene, y **decide una persona**, en tres casos:

1. **Lo que ve o hace un usuario** — un texto, un flujo, a dónde lleva un botón.
2. **El esquema de la base de datos.**
3. **Privacidad** — fotos, contacto de quien reporta, retención o borrado.

El corte es **por consecuencia, no por tamaño**: un PR de una línea que cambia
lo que lee una familia espera; un refactor de trescientas líneas que no cambia
nada observable, no.

**Si tu cambio cae en una de las tres: dilo con esas palabras en el PR y no lo
mergees.** Es la misma frontera que en `CONTRIBUTING.md` manda a abrir un issue
antes de construir. Un agente no cierra estos PRs: los deja listos y los declara.

### 4. Privacidad, que acá es una regla de ingeniería

No es un aviso legal al pie. Es lo que gobierna el código:

- **Solo sale información pública.** El contacto de quien reporta (`contact`)
  **nunca** aparece en una respuesta pública ni viaja en un mensaje saliente:
  se le muestra a un rescatista en pantalla tras una coincidencia facial, y ya.
  Ninguna fila de `updates` sale cruda — pasa por `publicUpdate()` /
  `maskReporter()` en [`src/privacy.js`](src/privacy.js), que es la única puerta.
- **Los avisos a terceros no salen solos.** `NOTIFY_MODE` está en `relay` por
  omisión: se relevan a un buzón de operación para que una persona verifique al
  destinatario. Entregarle el contacto de una familia a un desconocido que dice
  haber rescatado a alguien es un vector de extorsión.
- **Las dos reglas de fotos son opuestas a propósito.** La del **rescatista**
  se compara, se indexa su firma facial y los bytes se borran — nunca se guarda
  ni se muestra. La de un **reporte de desaparecido** sí se guarda y sí se
  publica, porque de eso se trata.
- **Nunca datos de personas reales en el repo**: ni en un test, ni en un
  fixture, ni en un log, ni en un pantallazo, ni en un comentario. Los tests
  usan nombres sintéticos ("Persona Prueba Uno") a propósito, y así se quedan.
- **Nunca credenciales.** Variable nueva → a `.env.example` con un valor de
  ejemplo. Nunca leas ni pegues el contenido de un `.env`.
- Ley 1581 (habeas data): retención finita y borrado real —
  `DELETE /api/people/:id` cumple esa promesa. La política pública vive en
  `/privacidad`; el código tiene que poder sostenerla.

---

## El panel: agregado, y solo agregado

La regla 4 cubre lo que sale por una respuesta o un mensaje. Falta la
superficie donde es más fácil filtrar sin darse cuenta, porque uno no siente
que esté publicando nada: **una cifra**. En `/admin/stats` el primer prompt
razonable —«muéstrame las últimas coincidencias para depurar esto»— devuelve
una tabla de personas reales.

- **Nunca un individuo en pantalla.** Ni nombres, ni teléfonos, ni correos, ni
  `person_id` / `face_id` / `update_id`, ni visibles ni en el HTML. El detalle
  por persona vive detrás de sesión, en `/api/admin/*`, y hoy ni siquiera
  existe.
- **Supresión de celdas pequeñas: un conteo entre 1 y 4 se muestra `<5`.** Un
  uno no describe a un agregado, describe a una persona.
- **Dos métricas prohibidas**, escritas precisamente porque a alguien le van a
  parecer buenas ideas:
  1. Cualquier corte de **«buscadas sin coincidencia hace más de N días»**. Eso
     no es una métrica de operación: es una lista priorizada de las familias
     más desesperadas, ordenada por desesperación.
  2. Cualquier cifra de **«familias con contacto disponible vs. sin contacto»**.
     Le dice a quien quiera cosechar contactos si vale la pena intentarlo.

  El riesgo de extorsión a familiares en un desastre no es hipotético — es la
  razón por la que `NOTIFY_MODE` está en `relay` (regla 4).
- **Cada cifra dice qué unidad cuenta y de qué lado del cruce** («fotos de quien
  busca», no «personas»), y **un cero nunca puede parecer un hecho medido cuando
  es un punto ciego**: si no se pudo medir, la página lo dice con esas palabras.

Agregar o cambiar una cifra del panel cae en **privacidad**: se declara en el PR
y lo decide una persona (regla 3).

---

## Antes de tocar algo, lee

| Vas a… | Lee primero |
|---|---|
| editar cualquier cosa bajo `src/` | [`agent.md`](agent.md) → «Mapa del código» y **«Trampas al editar»** (todas tienen cicatriz) |
| agregar o cambiar una prueba | [`agent.md`](agent.md) → «Correr y probar», y una prueba vecina en `test/` |
| tocar la base de datos | [`agent.md`](agent.md) → `src/store/` — **no hay carpeta de migraciones** |
| tocar fotos, contacto o notificaciones | la regla 4 de arriba, [`src/privacy.js`](src/privacy.js) y `test/privacy.test.js` |
| tocar una cifra de `/admin/stats` | «El panel: agregado, y solo agregado», arriba — y `npm run seed` para tener qué mirar |
| mandar el cambio | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| entender el producto de cara al usuario | [`README.md`](README.md) |
| reportar algo de seguridad | [`SECURITY.md`](SECURITY.md) — **nunca en un issue público** |

Cosas que se rompen sin querer y ya están escritas en `agent.md`: el HTML se
arma concatenando strings y **todo dato de afuera pasa por `esc()`**; Express 4
no atrapa errores async, por eso existe `wrap()`; `matcher.enabled` miente si no
esperaste `ensureReady()`; una columna nueva se agrega **en los dos**
adaptadores.

Convenciones que no están escritas en ningún lint: **toda la interfaz y los
mensajes al usuario van en español**; sin frameworks y sin paso de build, a
propósito, porque esto tiene que abrir en un teléfono viejo con una barra de
señal; los comentarios explican **por qué**, no qué.

---

## Correr y probar

```bash
npm install
npm run seed    # datos sintéticos en la base local — sin esto arranca vacía
npm run dev     # SQLite en ./data/encontrados.db → http://localhost:3000
npm test        # node --test, sin red y sin servicios externos
```

`npm run seed` se niega a correr si detecta Postgres, Vercel o
`NODE_ENV=production`: solo siembra la base local, y borra su propia siembra
anterior antes de repetir.

**No necesitas credenciales de nada.** Sin AWS el reconocimiento facial queda
apagado (las fotos igual se guardan), sin SendGrid no sale correo, sin
`DATABASE_URL` se usa SQLite local. Todo eso se degrada solo y lo dice en el log.

`npm test` **en verde antes de abrir el PR** — CI corre lo mismo y sin eso no
entra. Si muere con `ERR_DLOPEN_FAILED` o un `NODE_MODULE_VERSION` que no cuadra,
es `better-sqlite3` compilado para otro Node: `npm rebuild better-sqlite3`. Es el
entorno, no tu cambio.

---

## Cómo se manda un cambio

1. Rama desde el `main` actual (`git fetch origin && git switch -c … origin/main`).
2. Commit y **título de PR en español, describiendo el efecto, no el archivo**:
   «El contacto de una familia ya no viaja en ningún mensaje que se envíe», no
   «actualiza notify.js». Si hay issue, referéncialo.
3. En el cuerpo: qué se rompía, qué hiciste y **cómo lo verificaste**. Los
   números convencen más que los adjetivos.
4. `npm test` en verde y la casilla marcada en la plantilla del PR.
5. Si cae en una de las tres categorías de la regla 3, **decláralo y espera a una
   persona**.

Tu PR levanta un **preview deployment**: una copia desechable con base vacía y
sin datos reales. Es para ver tu cambio, no para probar contra producción.

---

## Lo que un agente no hace acá

- **No mergea ni aprueba** un PR que cambia comportamiento de cara al usuario,
  el esquema o privacidad. Tampoco el suyo propio: GitHub no lo permite y está
  bien que no lo permita.
- **No toca producción**: ni desplegar, ni escribirle a la base de producción,
  ni correr un endpoint que gaste cuota o le mande un correo a alguien real.
- **No inventa datos de personas** para probar. Nombres sintéticos, siempre.
- **No agrega una dependencia** sin preguntarse antes si el problema se resuelve
  sin ella. Casi siempre sí.

---

## Herramientas de este repo

En [`.claude/`](.claude/README.md) hay comandos para lo que más se repite:
`/pruebas`, `/pr-chico`, `/revision-privacidad` y `/cambio-de-esquema`. Y ahí
mismo está el **arranque rápido** para alguien que llega por primera vez.
