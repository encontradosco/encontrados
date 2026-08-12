const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createLazyMatcher, nullMatcher } = require('../src/faces');

// El ciclo de vida del matcher se probaba llamador por llamador: cada uno
// construía su propio doble dormido, y un llamador nuevo se enviaba sin probar.
// El historial lo confirma — 741b94d y 3357fd4 son dos commits arreglando el
// MISMO bug en sitios distintos. Estas pruebas lo cubren una sola vez, en el
// módulo, incluidos los llamadores que todavía no existen.

// Sin credenciales de AWS, createMatcher devuelve el nullMatcher sin tocar la
// red. Se limpian para que el resultado no dependa del shell de quien corre.
function withoutAws(t) {
  const saved = {
    id: process.env.AWS_ACCESS_KEY_ID,
    secret: process.env.AWS_SECRET_ACCESS_KEY
  };
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  t.after(() => {
    if (saved.id !== undefined) process.env.AWS_ACCESS_KEY_ID = saved.id;
    if (saved.secret !== undefined) process.env.AWS_SECRET_ACCESS_KEY = saved.secret;
  });
}

test('no queda ninguna propiedad de disponibilidad que se pueda leer antes de tiempo', (t) => {
  withoutAws(t);
  const matcher = createLazyMatcher();

  // El bug entero cabía en estas dos líneas: `enabled` existía, se podía leer
  // sin haber inicializado, y respondía `false` con Rekognition disponible.
  // Que la propiedad no exista es la garantía — no hay nada que leer mal.
  assert.equal('enabled' in matcher, false, 'el matcher no debe exponer `enabled`');
  assert.equal(matcher.enabled, undefined);
  assert.equal(typeof matcher.ensureReady, 'undefined', 'ya no hay un paso previo que olvidar');
  assert.equal(typeof matcher.ready, 'function');
});

test('ready() inicializa y responde en la misma llamada', async (t) => {
  withoutAws(t);
  const matcher = createLazyMatcher();

  // Sin credenciales la respuesta honesta es `false`, y llega ya inicializado:
  // no hay un estado intermedio en el que la respuesta sea "todavía no sé".
  assert.equal(await matcher.ready(), false);
  assert.match(matcher.status, /deshabilitado/);
});

test('el nullMatcher responde por el mismo contrato', async () => {
  assert.equal('enabled' in nullMatcher, false);
  assert.equal(await nullMatcher.ready(), false);
});

// El guard que cubre a los llamadores que todavía no existen. La trampa vieja
// se reproducía sola: cada sitio nuevo que necesitara saber si hay
// reconocimiento facial volvía a escribir la lectura síncrona, y el bug
// reaparecía. Si alguien la reintroduce, esto falla acá y no en producción.
test('ningún módulo vuelve a leer la disponibilidad de forma síncrona', () => {
  const srcDir = path.join(__dirname, '..', 'src');
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  })(srcDir);

  const offenders = [];
  for (const file of files) {
    // faces.js es el dueño del ciclo de vida: adentro sí puede hablar de
    // `real.ready()` y de su propio estado. La regla es para sus clientes.
    if (path.basename(file) === 'faces.js') continue;
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (/\bmatcher\.enabled\b|\bensureReady\b/.test(line)) {
          offenders.push(`${path.relative(srcDir, file)}:${i + 1}`);
        }
      });
  }

  assert.deepEqual(
    offenders,
    [],
    `usa \`await matcher.ready()\` en vez de leer la disponibilidad de forma síncrona: ${offenders.join(', ')}`
  );
});
