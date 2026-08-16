// El veto de #150: un parecido de nombre ya no alcanza para fusionar dos
// reportes cuando el departamento o la edad que declararon se contradicen.
//
// Lo que estas pruebas protegen:
//   - que lo que hoy fusiona bien —variantes ortográficas del mismo nombre en
//     el mismo lugar— siga fusionando; es el criterio de aceptación del issue
//     y lo más fácil de romper con un veto;
//   - que una señal ausente NUNCA vete, porque casi ningún update la trae;
//   - que el veto no pierda el reporte: le abre su propio registro, y ese
//     registro sale en el aviso de posible duplicado que ya existe;
//   - que un nombre normalizado idéntico siga cayendo en la misma persona.
const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { nullMatcher } = require('../src/faces');
const { createStore } = require('../src/people');
const { mergeBlockReason, AGE_MARGIN_YEARS } = require('../src/merge-guard');

async function freshStore() {
  return createStore(await createSqliteAdapter(':memory:'));
}

async function photoBytes() {
  return sharp({
    create: { width: 400, height: 500, channels: 3, background: { r: 120, g: 90, b: 60 } }
  })
    .jpeg()
    .toBuffer();
}

// Un reporte, con las señales que se le quieran poner.
async function reportar(store, name, { department = null, age = null, status = 'missing' } = {}) {
  const res = await store.findOrCreatePerson(name, { department, age });
  await store.addUpdate(res.person.id, {
    status,
    location: 'Un lugar de prueba',
    source: 'web',
    department,
    age
  });
  return res;
}

// ------------------------------------------------------------------ la regla
// Se prueba sola, sin base: es la única parte con lógica de decisión, y una
// tabla de verdad se lee mejor que seis reportes montados.

test('la regla no veta cuando falta la señal de cualquiera de los dos lados', () => {
  assert.equal(mergeBlockReason({ department: null, age: null }, [{ department: 'Quindío', age: 34 }]), null);
  assert.equal(mergeBlockReason({ department: 'Quindío', age: 34 }, [{ department: null, age: null }]), null);
  assert.equal(mergeBlockReason({ department: 'Quindío', age: 34 }, []), null, 'un registro sin updates no contradice nada');
});

test('la regla veta cuando el departamento contradice a UNA sola declaración', () => {
  assert.equal(mergeBlockReason({ department: 'Quindío' }, [{ department: 'Quindío' }]), null);
  assert.equal(mergeBlockReason({ department: 'Quindío' }, [{ department: 'Antioquia' }]), 'department');

  // Un registro que ya juntó dos departamentos es la huella de una fusión mala.
  // La regla suave —«que no coincida con ninguno»— lo dejaría seguir tragando
  // reportes de los dos lados, que es como el caso real llegó a seis fichas.
  const contaminado = [{ department: 'Quindío' }, { department: 'Antioquia' }];
  assert.equal(mergeBlockReason({ department: 'Quindío' }, contaminado), 'department');
  assert.equal(mergeBlockReason({ department: 'Antioquia' }, contaminado), 'department');
});

test('la regla veta la edad solo pasado el margen', () => {
  assert.equal(AGE_MARGIN_YEARS, 5);
  assert.equal(mergeBlockReason({ age: 34 }, [{ age: 34 }]), null);
  assert.equal(mergeBlockReason({ age: 34 }, [{ age: 39 }]), null, 'justo en el margen todavía fusiona');
  assert.equal(mergeBlockReason({ age: 34 }, [{ age: 40 }]), 'age');
  // El caso real del issue: 20 y 24 en una ciudad, 33 y 36 en otra.
  assert.equal(mergeBlockReason({ age: 24 }, [{ age: 33 }]), 'age');

  // Cero es una edad real —un bebé— y no puede leerse como "no declarada".
  assert.equal(mergeBlockReason({ age: 0 }, [{ age: 4 }]), null);
  assert.equal(mergeBlockReason({ age: 0 }, [{ age: 30 }]), 'age');
});

test('el departamento se revisa antes que la edad', () => {
  assert.equal(mergeBlockReason({ department: 'Quindío', age: 60 }, [{ department: 'Antioquia', age: 20 }]), 'department');
});

// ----------------------------------------------------------- lo que no cambia
// Primero lo que tiene que seguir igual: un veto que rompa esto cuesta más de
// lo que arregla.

test('una variante ortográfica en el mismo departamento sigue fusionando', async () => {
  const store = await freshStore();
  const primero = await reportar(store, 'Persona Prueba Uno', { department: 'Quindío', age: 34 });
  // 0.967 sobre el nombre normalizado: es exactamente la fusión que queremos.
  const segundo = await reportar(store, 'Persona Prueva Uno', { department: 'Quindío', age: 35 });

  assert.equal(segundo.created, false, 'tiene que caer en la persona que ya existía');
  assert.equal(segundo.person.id, primero.person.id);
  assert.equal(segundo.blocked ?? null, null);
  await store.close();
});

test('sin ninguna señal, la fusión por parecido se comporta como siempre', async () => {
  const store = await freshStore();
  const primero = await reportar(store, 'Persona Prueba Uno');
  const segundo = await reportar(store, 'Persona Prueba Nuno');

  assert.equal(segundo.created, false, 'un dato que no llegó no separa a nadie');
  assert.equal(segundo.person.id, primero.person.id);
  await store.close();
});

test('un nombre normalizado idéntico cae en la misma persona aunque el departamento cambie', async () => {
  const store = await freshStore();
  // Dos familiares reportan a la misma persona: uno dice dónde vivía, el otro
  // dónde la vieron. Un nombre idéntico es una señal mucho más fuerte que un
  // parecido, y el veto no entra en ese camino.
  const primero = await reportar(store, 'Persona Prueba Dos', { department: 'Quindío' });
  const segundo = await reportar(store, 'PERSONA PRUEBA DOS', { department: 'Valle del Cauca' });

  assert.equal(segundo.created, false);
  assert.equal(segundo.person.id, primero.person.id);
  await store.close();
});

// La calidad del veto depende de que la pregunta sea UNA. «Dónde estaba o
// vivía» son dos: un familiar contesta la residencia y otro el último lugar
// donde la vieron, y entonces el mismo registro acumula dos departamentos y el
// veto separa a una sola persona. La residencia es la que sirve, porque no
// cambia con cada reporte; dónde estaba ya lo pregunta el campo de arriba.
test('el formulario pregunta por la residencia, no por dos cosas a la vez', async (t) => {
  const app = await createApp(await createSqliteAdapter(':memory:'), nullMatcher);
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  t.after(() => server.close());

  const html = await (await fetch(`http://127.0.0.1:${server.address().port}/report`)).text();
  assert.match(html, /Departamento donde vivía/);
  assert.doesNotMatch(html, /Departamento donde estaba o vivía/);
});

// ------------------------------------------------------------------- el veto

test('dos nombres parecidos en departamentos distintos crean personas separadas', async () => {
  const store = await freshStore();
  const primero = await reportar(store, 'Persona Prueba Uno', { department: 'Quindío' });
  const segundo = await reportar(store, 'Persona Prueba Nuno', { department: 'Antioquia' });

  assert.equal(segundo.created, true, 'el reporte estrena su propio registro');
  assert.notEqual(segundo.person.id, primero.person.id);
  assert.equal(segundo.blocked.reason, 'department');
  assert.equal(String(segundo.blocked.personId), String(primero.person.id));
  assert.ok(segundo.blocked.score >= 0.85, 'el score que lo habría fusionado queda registrado');

  // Y el reporte está entero: separar no es descartar.
  const updates = await store.getUpdates(segundo.person.id);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].department, 'Antioquia');
  await store.close();
});

test('dos nombres parecidos con edades lejanas crean personas separadas', async () => {
  const store = await freshStore();
  const primero = await reportar(store, 'Persona Prueba Uno', { age: 33 });
  const segundo = await reportar(store, 'Persona Prueba Nuno', { age: 24 });

  assert.equal(segundo.created, true);
  assert.notEqual(segundo.person.id, primero.person.id);
  assert.equal(segundo.blocked.reason, 'age');
  await store.close();
});

test('un registro que ya juntó dos departamentos deja de absorber reportes', async () => {
  const store = await freshStore();
  // La huella de una fusión mala anterior: dos departamentos en un registro.
  const { person } = await store.findOrCreatePerson('Persona Prueba Uno');
  for (const department of ['Quindío', 'Antioquia']) {
    await store.addUpdate(person.id, { status: 'missing', source: 'web', department });
  }

  const nuevo = await reportar(store, 'Persona Prueba Nuno', { department: 'Quindío' });
  assert.equal(nuevo.created, true, 'aunque coincida con uno de los dos, el registro ya no es de fiar');
  assert.equal(nuevo.blocked.reason, 'department');
  await store.close();
});

// ------------------------------------------------------- el reporte de verdad

test('un reporte web vetado entra igual, y sale como posible duplicado', async (t) => {
  const app = await createApp(await createSqliteAdapter(':memory:'), nullMatcher);
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const enviar = async (name, department) => {
    const fd = new FormData();
    fd.set('name', name);
    fd.set('location', 'Un lugar de prueba');
    fd.set('contact_phone', '300 123 4567');
    fd.set('department', department);
    fd.append('photos', new File([await photoBytes()], 'f.jpg', { type: 'image/jpeg' }));
    const res = await fetch(`${base}/report`, { method: 'POST', body: fd, redirect: 'manual' });
    assert.equal(res.status, 303, 'ningún veto puede costarle el reporte a una familia');
    return {
      id: Number(res.headers.get('location').match(/^\/person\/(\d+)\?/)[1]),
      // El hallazgo de duplicado viaja en una cookie de vida corta, no en la
      // URL: afirma que dos personas buscadas pueden ser una sola, y eso solo
      // se le dice a quien acaba de reportar. Sin la cookie no hay aviso.
      cookie: (res.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ')
    };
  };

  const primero = await enviar('Persona Prueba Uno', 'Quindío');
  const segundo = await enviar('Persona Prueba Nuno', 'Antioquia');
  assert.notEqual(segundo.id, primero.id, 'dos departamentos, dos registros');

  // La red que hace barato equivocarse vetando: el parecido de nombre sigue
  // cayendo en la banda de aviso de src/duplicates.js, así que la separación
  // queda a la vista de una persona que puede unirlos si de verdad son uno.
  const html = await (
    await fetch(`${base}/person/${segundo.id}?reported=1`, { headers: { cookie: segundo.cookie } })
  ).text();
  assert.match(html, /Persona Prueba Uno/, 'el registro del que se separó tiene que quedar a la vista');

  // Los dos siguen buscados: fusionar mal es lo que sacaba a uno de la lista.
  const home = await (await fetch(`${base}/`)).text();
  assert.match(home, /Persona Prueba Uno/);
  assert.match(home, /Persona Prueba Nuno/);
});
