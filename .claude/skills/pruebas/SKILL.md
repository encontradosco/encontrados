---
name: pruebas
description: Correr la suite de este repo y escribir pruebas nuevas calcando sus convenciones (node --test sin framework, SQLite en memoria, puerto 0, matcher falso, servidores de mentira para SendGrid y GitHub, nombres sintéticos). Úsala cuando haya que correr `npm test`, agregar o arreglar una prueba, cuando la suite falle con un error de `better-sqlite3`/`NODE_MODULE_VERSION`, o cuando alguien pregunte qué cubre la suite o cómo probar un cambio.
---

# Pruebas

La suite es `node --test` sobre `test/**/*.test.js`. **Sin framework, sin
mocks mágicos, sin red.** Antes de escribir una prueba nueva, abre una vecina del
mismo tema y cálcala — es más rápido y sale más parecida al resto.

## Correr

```bash
npm test
```

Tiene que quedar **en verde antes de abrir el PR**: CI corre exactamente lo mismo
en Node 22, en cada PR y en `main`, y sin eso el PR no entra.

Para una sola:

```bash
node --test test/privacy.test.js
```

**Si muere con `ERR_DLOPEN_FAILED` o un `NODE_MODULE_VERSION` que no cuadra**, no
es tu cambio: es `better-sqlite3` compilado para otra versión de Node.

```bash
npm rebuild better-sqlite3
```

Y vuelve a correr.

## Escribir una prueba

Las convenciones, todas verificables en `test/`:

**Cada prueba levanta su propia app**, contra SQLite en memoria y escuchando en
el puerto 0. Nada se comparte entre archivos, así que ninguna prueba puede
ensuciar a otra (patrón exacto en `test/app.test.js`):

```js
const app = await createApp(await createSqliteAdapter(':memory:'), nullMatcher);
const server = await new Promise((resolve) => {
  const s = app.listen(0, () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;
```

Y se cierra con `t.after(() => server.close())`.

**El matcher es el `nullMatcher` de `src/faces.js`**, salvo que la prueba
necesite coincidencias de verdad. Para eso, el patrón está en
`test/rescue.test.js`: un matcher falso local donde *bytes idénticos = mismo
rostro*, devolviendo una geometría con la forma exacta que devuelve Rekognition
(caja, puntos, pose, confianza como proporciones). Así el pipeline completo corre
sin AWS.

**Los servicios externos tienen servidores de mentira** en `test/helpers.js`:
`fakeSendgrid()` y `fakeGithub()` levantan un HTTP local y se enchufan por
`SENDGRID_API_BASE` / `GITHUB_API_BASE`. Existen por dos razones: para recorrer
el camino de «sí se mandó» y no solo el de la falla, y para que un `GITHUB_TOKEN`
que alguien tenga en su shell no abra issues de verdad. Úsalos, no mockees el
módulo.

**Nombres sintéticos, siempre.** «Persona Prueba Uno», `familia@ejemplo.com`,
teléfonos inventados. Nunca datos de una persona real — ni en la prueba, ni en un
fixture, ni en el mensaje del assert. Es regla dura del proyecto, no estilo.

**Prueba el comportamiento, no la implementación.** Los tests de este repo
afirman sobre respuestas HTTP y sobre lo que sale por la puerta pública, no sobre
funciones internas — salvo cuando la función *es* la garantía (`maskReporter`,
`publicUpdate`, `matchScore`).

## Qué cubrir según lo que tocaste

- **Algo que sale a una respuesta pública** → una afirmación explícita de que el
  campo sensible **no** está. Mira `test/privacy.test.js`: el patrón es
  `assert.ok(!salida.includes(<el dato>))`, no solo comparar contra lo esperado.
  Un `deepEqual` pasa aunque el dato viaje en otro campo.
- **Una variable de entorno nueva** → el camino «sin configurar». Casi toda
  variable acá apaga una función en silencio; esa rama también es comportamiento.
- **Una columna nueva** → `test/schema-bootstrap.test.js` y `/cambio-de-esquema`.
- **Un flujo async en una ruta** → que el error no tumbe el proceso; toda ruta
  async va envuelta en el `wrap()` que ya existe en el archivo.
