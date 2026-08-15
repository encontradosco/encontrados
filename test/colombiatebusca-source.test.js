const test = require('node:test');
const assert = require('node:assert');
const {
  personUrlsFromSitemap,
  personIdFromUrl,
  canonicalPersonUrl,
  parsePersonPage,
  toUpdate,
  mapStatus,
  mapSex,
  parseAge,
  parseRegisteredAt
} = require('../src/sources/colombiatebusca');
const { STATUSES, SOURCES } = require('../src/people');

// HTML sintético con la forma de una ficha real: un <aside id="detailDrawer">
// con <h1>, una <img> a media.php y una lista de pares <dt>/<dd>. Los nombres
// son inventados (regla dura del repo: nunca datos personales reales).
function fichaHtml(overrides = {}) {
  const f = {
    nombre: 'Persona Prueba Uno',
    estado: 'Por localizar',
    categoria: 'Desaparici&oacute;n forzada',
    documento: '*****656',
    lugar: 'Barrio Ejemplo, Qubd&oacute;',
    edad: '34 a&ntilde;os',
    genero: 'Femenino',
    registrado: '10/08/2026 05:51 PM',
    ...overrides
  };
  return `<!doctype html><html><body>
    <main>Contenido que no importa</main>
    <aside id="detailDrawer" class="drawer open">
      <h1>${f.nombre}</h1>
      <img src="/media.php?id=abc123&amp;type=full" alt="Foto">
      <dl>
        <dt>Estado</dt><dd><span class="badge badge-danger">${f.estado}</span></dd>
        <dt>Categor&iacute;a</dt><dd>${f.categoria}</dd>
        <dt>Documento</dt><dd>${f.documento}</dd>
        <dt>&Uacute;ltimo lugar visto</dt><dd>${f.lugar}</dd>
        <dt>Edad</dt><dd>${f.edad}</dd>
        <dt>G&eacute;nero</dt><dd>${f.genero}</dd>
        <dt>Registrado</dt><dd>${f.registrado}</dd>
      </dl>
    </aside>
  </body></html>`;
}

const UUID = '11111111-2222-3333-4444-555555555555';
const PAGE_URL = `https://colombiatebusca.com/?person=${UUID}`;

// --- sitemap ---------------------------------------------------------------

test('el sitemap entrega las URLs de ficha canonicalizadas y en orden', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <urlset>
      <url><loc>https://colombiatebusca.com/</loc></url>
      <url><loc>https://colombiatebusca.com/?person=AAAAAAAA-1111-2222-3333-444444444444</loc></url>
      <url><loc>http://colombiatebusca.com/index.php?person=bbbbbbbb-1111-2222-3333-444444444444&amp;utm=x</loc></url>
      <url><loc>https://colombiatebusca.com/contacto.php</loc></url>
    </urlset>`;
  assert.deepStrictEqual(personUrlsFromSitemap(xml), [
    'https://colombiatebusca.com/?person=aaaaaaaa-1111-2222-3333-444444444444',
    'https://colombiatebusca.com/?person=bbbbbbbb-1111-2222-3333-444444444444'
  ]);
});

// El <loc> venía de un sitio que no controlamos y solo se le pedía que
// CONTUVIERA `?person=<hex>`. Un sitemap alterado entregaba URLs de terceros
// que el consumidor iba a ir a buscar creyendo que eran fichas.
test('el sitemap descarta todo lo que no sea colombiatebusca por https/http', () => {
  const xml = `<urlset>
      <url><loc>https://evil.example.com/?person=aaaaaaaa-1111-2222-3333-444444444444</loc></url>
      <url><loc>https://colombiatebusca.com.evil.example/?person=bbbbbbbb-1111-2222-3333-444444444444</loc></url>
      <url><loc>javascript:alert(1)?person=cccccccc-1111-2222-3333-444444444444</loc></url>
      <url><loc>file:///etc/passwd?person=dddddddd-1111-2222-3333-444444444444</loc></url>
      <url><loc>no es una url ?person=eeeeeeee-1111-2222-3333-444444444444</loc></url>
    </urlset>`;
  assert.deepStrictEqual(personUrlsFromSitemap(xml), []);
});

test('el sitemap no repite una ficha que aparece dos veces con URLs distintas', () => {
  const xml = `<urlset>
      <url><loc>https://colombiatebusca.com/?person=${UUID}</loc></url>
      <url><loc>http://colombiatebusca.com/index.php?person=${UUID}</loc></url>
    </urlset>`;
  assert.deepStrictEqual(personUrlsFromSitemap(xml), [PAGE_URL]);
});

test('el sitemap sin fichas devuelve una lista vacía, no revienta', () => {
  assert.deepStrictEqual(personUrlsFromSitemap('<urlset></urlset>'), []);
  assert.deepStrictEqual(personUrlsFromSitemap(''), []);
});

// --- parseo de la ficha ----------------------------------------------------

test('una ficha entrega nombre, foto absoluta y sus campos', () => {
  const parsed = parsePersonPage(fichaHtml(), PAGE_URL);
  assert.strictEqual(parsed.fullName, 'Persona Prueba Uno');
  assert.strictEqual(parsed.photoUrl, 'https://colombiatebusca.com/media.php?id=abc123&type=full');
  assert.strictEqual(parsed.fields['Estado'], 'Por localizar');
  assert.strictEqual(parsed.fields['Último lugar visto'], 'Barrio Ejemplo, Qubdó');
  assert.strictEqual(parsed.fields['Categoría'], 'Desaparición forzada');
});

test('una página sin cajón de detalle o sin nombre se salta', () => {
  assert.strictEqual(parsePersonPage('<html><body>Nada</body></html>', PAGE_URL), null);
  assert.strictEqual(parsePersonPage(fichaHtml({ nombre: '' }), PAGE_URL), null);
});

// El documento censurado se descarta DENTRO de parsePersonPage, no más abajo:
// las dos funciones están exportadas, así que dejar el filtro solo en toUpdate
// significaba que un consumidor que llamara parsePersonPage lo recibía igual —
// justo lo contrario de lo que promete el comentario del módulo.
test('el documento censurado no sale de parsePersonPage', () => {
  const parsed = parsePersonPage(fichaHtml(), PAGE_URL);
  const serialized = JSON.stringify(parsed);
  assert.ok(!('Documento' in parsed.fields), 'la clave no debe existir en fields');
  assert.ok(!serialized.includes('656'), 'el número parcial no debe viajar');
  assert.ok(!/documento|cedula|cédula/i.test(serialized), 'ninguna clave ni valor debe mencionarlo');
});

test('el documento tampoco sale de toUpdate', () => {
  const serialized = JSON.stringify(toUpdate(parsePersonPage(fichaHtml(), PAGE_URL), PAGE_URL));
  assert.ok(!serialized.includes('656'));
  assert.ok(!/documento/i.test(serialized));
});

// Se barrían las etiquetas y DESPUÉS se decodificaban las entidades, así que
// el marcado que la fuente hubiera codificado volvía a materializarse dentro
// del nombre — y ese nombre es el que se guarda y del que se derivan las
// llaves de búsqueda difusa con las que una familia encuentra a los suyos.
test('el marcado codificado en origen no vuelve a aparecer en el texto', () => {
  const parsed = parsePersonPage(
    fichaHtml({ nombre: '&lt;img src=x onerror=alert(1)&gt;Persona Prueba Dos' }),
    PAGE_URL
  );
  assert.ok(!parsed.fullName.includes('<'), `no debe traer marcado: ${parsed.fullName}`);
  assert.ok(!parsed.fullName.includes('onerror='), `no debe traer manejadores: ${parsed.fullName}`);
  assert.ok(parsed.fullName.includes('Persona Prueba Dos'));
});

test('las etiquetas anidadas se separan con espacio, no se pegan', () => {
  const parsed = parsePersonPage(fichaHtml({ nombre: '<b>Persona</b><i>Prueba</i>' }), PAGE_URL);
  assert.strictEqual(parsed.fullName, 'Persona Prueba');
});

// Una entidad numérica basura bastaba para lanzar RangeError y tumbar el
// parseo de la ficha entera, contra el contrato de "una ficha ilegible se
// salta, no revienta el barrido".
test('una entidad numérica fuera de rango no revienta el parseo', () => {
  for (const roto of ['A&#1114112;B', 'A&#x110000;B', 'A&#55296;B', 'A&#999999999999;B']) {
    const parsed = parsePersonPage(fichaHtml({ nombre: roto }), PAGE_URL);
    assert.ok(parsed && parsed.fullName, `debió parsear: ${roto}`);
  }
});

// `name in named` caminaba la cadena de prototipos, así que `&toString;` se
// reemplazaba por el código fuente de Object.prototype.toString.
test('una entidad con nombre de método de Object se deja tal cual', () => {
  for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
    const parsed = parsePersonPage(fichaHtml({ nombre: `Persona&${name};Prueba` }), PAGE_URL);
    assert.ok(!parsed.fullName.includes('native code'), `filtró un método: ${parsed.fullName}`);
    assert.ok(parsed.fullName.includes(`&${name};`), `debió dejarla intacta: ${parsed.fullName}`);
  }
});

test('una etiqueta que el servidor parte en dos líneas igual se encuentra', () => {
  const html = `<aside id="detailDrawer"><h1>Persona Prueba Uno</h1><dl>
      <dt>&Uacute;ltimo
         lugar   visto</dt><dd>Barrio Ejemplo</dd>
    </dl></aside>`;
  assert.strictEqual(parsePersonPage(html, PAGE_URL).fields['Último lugar visto'], 'Barrio Ejemplo');
});

test('una foto que apunta a otro dominio se descarta', () => {
  const html = `<aside id="detailDrawer"><h1>Persona Prueba Uno</h1>
    <img src="https://evil.example.com/media.php?id=1"></aside>`;
  assert.strictEqual(parsePersonPage(html, PAGE_URL).photoUrl, undefined);
});

// --- traducción de campos --------------------------------------------------

// La traducción es por etiqueta COMPLETA. Con substring, "No localizada"
// contenía "localizad" y una persona que sigue desaparecida se publicaba como
// `safe`: se cae del listado de desaparecidos, entra al conteo de reencontradas
// y a cada familia suscrita le llega que su familiar apareció.
test('un estado negado o calificado NO se adivina', () => {
  assert.strictEqual(mapStatus('Por localizar'), 'missing');
  assert.strictEqual(mapStatus('POR LOCALIZAR'), 'missing');
  assert.strictEqual(mapStatus('Localizada'), 'safe');
  assert.strictEqual(mapStatus('Localizado'), 'safe');

  for (const negado of ['No localizada', 'Aún no localizada', 'NO LOCALIZADO', 'Sin localizar']) {
    assert.strictEqual(mapStatus(negado), 'unknown', `"${negado}" no puede leerse como safe`);
  }
  // La app tiene `deceased`, pero traducir a ese valor una etiqueta que nunca
  // hemos visto es adivinar sobre la muerte de alguien: que lo mire una persona.
  assert.strictEqual(mapStatus('Localizada sin vida'), 'unknown');
  assert.strictEqual(mapStatus('En verificación'), 'unknown');
  assert.strictEqual(mapStatus(undefined), 'unknown');
  assert.strictEqual(mapStatus(''), 'unknown');
});

test('edad y género se leen; lo que no viene queda indefinido', () => {
  assert.strictEqual(parseAge('34 años'), 34);
  assert.strictEqual(parseAge('Sin dato'), undefined);
  assert.strictEqual(parseAge(undefined), undefined);
  assert.strictEqual(parseAge('900 años'), undefined, 'una edad imposible no es un dato');
  assert.strictEqual(mapSex('Femenino'), 'f');
  assert.strictEqual(mapSex('Masculino'), 'm');
  assert.strictEqual(mapSex('No binario'), 'otro');
  assert.strictEqual(mapSex(undefined), undefined);
});

test('la fecha de registro se interpreta en hora de Colombia', () => {
  assert.strictEqual(parseRegisteredAt('10/08/2026 05:51 PM').toISOString(), '2026-08-10T22:51:00.000Z');
  assert.strictEqual(parseRegisteredAt('10/08/2026 09:05 AM').toISOString(), '2026-08-10T14:05:00.000Z');
  // Medianoche y mediodía son donde el %12 se equivoca si está mal escrito.
  assert.strictEqual(parseRegisteredAt('10/08/2026 12:00 AM').toISOString(), '2026-08-10T05:00:00.000Z');
  assert.strictEqual(parseRegisteredAt('10/08/2026 12:00 PM').toISOString(), '2026-08-10T17:00:00.000Z');
  assert.strictEqual(parseRegisteredAt('sin fecha'), undefined);
});

// `new Date` acomoda un 31/02 corriéndolo a marzo sin quejarse, y una fecha
// corrida es peor que no tener fecha.
test('una fecha que no existe en el calendario no se inventa', () => {
  assert.strictEqual(parseRegisteredAt('31/02/2026 10:00 AM'), undefined);
  assert.strictEqual(parseRegisteredAt('29/02/2026 10:00 AM'), undefined, '2026 no es bisiesto');
  assert.ok(parseRegisteredAt('29/02/2024 10:00 AM'), '2024 sí es bisiesto');
  assert.strictEqual(parseRegisteredAt('10/13/2026 10:00 AM'), undefined, 'no hay mes 13');
  assert.strictEqual(parseRegisteredAt('10/08/2026 13:00 PM'), undefined, 'no hay hora 13 en 12h');
  // Después de las 7 PM la fecha en UTC ya es la del día siguiente: validar el
  // calendario comparando campos UTC daría un falso negativo acá.
  assert.strictEqual(parseRegisteredAt('31/08/2026 11:30 PM').toISOString(), '2026-09-01T04:30:00.000Z');
});

// --- cuerpo de /api/updates ------------------------------------------------

test('la ficha se convierte al cuerpo de POST /api/updates', () => {
  const { update, details } = toUpdate(parsePersonPage(fichaHtml(), PAGE_URL), PAGE_URL);
  assert.deepStrictEqual(update, {
    name: 'Persona Prueba Uno',
    status: 'missing',
    location: 'Barrio Ejemplo, Qubdó',
    reporter: 'Colombia Te Busca',
    source: 'aggregator',
    external_id: PAGE_URL
  });
  assert.strictEqual(details.age, 34);
  assert.strictEqual(details.sex, 'f');
  assert.strictEqual(details.category, 'Desaparición forzada');
  assert.strictEqual(details.rawStatus, 'Por localizar');
  assert.strictEqual(details.photoUrl, 'https://colombiatebusca.com/media.php?id=abc123&type=full');
});

// external_id es la llave del upsert. Antes se tomaba el argumento tal cual,
// así que llamar sin él producía un cuerpo con `external_id: undefined` sin
// error ni aviso — y ese cuerpo INSERTA una fila nueva en cada barrido.
test('sin una URL de ficha utilizable no se arma ningún cuerpo', () => {
  const parsed = parsePersonPage(fichaHtml(), PAGE_URL);
  for (const malo of [undefined, '', 'https://colombiatebusca.com/', 'no es una url']) {
    assert.strictEqual(toUpdate(parsed, malo), null, `no debió armar cuerpo con ${JSON.stringify(malo)}`);
  }
});

test('external_id es idéntico aunque la URL de entrada varíe', () => {
  const parsed = parsePersonPage(fichaHtml(), PAGE_URL);
  const variantes = [
    PAGE_URL,
    `http://colombiatebusca.com/?person=${UUID}`,
    `https://colombiatebusca.com/index.php?person=${UUID}&utm_source=x`,
    `https://colombiatebusca.com/?person=${UUID.toUpperCase()}`
  ];
  for (const v of variantes) {
    assert.strictEqual(toUpdate(parsed, v).update.external_id, PAGE_URL, `varió con ${v}`);
  }
});

test('external_id es estable entre lecturas de la misma ficha', () => {
  const a = toUpdate(parsePersonPage(fichaHtml(), PAGE_URL), PAGE_URL).update;
  assert.strictEqual(a.status, 'missing');
  assert.strictEqual(a.external_id, canonicalPersonUrl(personIdFromUrl(PAGE_URL)));
});

// #78: una ficha "Localizada" en la fuente no llega como `safe` — llega como
// si el barrido nunca hubiera visto esta ficha. Empujarla inflaba el conteo
// público de "reencontradas" con gente que nunca pasó por esta app.
test('una ficha ya localizada en la fuente no se empuja como update', () => {
  const localizada = toUpdate(parsePersonPage(fichaHtml({ estado: 'Localizada' }), PAGE_URL), PAGE_URL);
  assert.strictEqual(localizada, null);

  const localizado = toUpdate(parsePersonPage(fichaHtml({ estado: 'Localizado' }), PAGE_URL), PAGE_URL);
  assert.strictEqual(localizado, null);

  // El filtro solo actúa sobre `safe` — cualquier otro estado (incluido
  // 'unknown', que es donde cae "No localizada") sigue empujándose igual.
  const noLocalizada = toUpdate(parsePersonPage(fichaHtml({ estado: 'No localizada' }), PAGE_URL), PAGE_URL);
  assert.strictEqual(noLocalizada.update.status, 'unknown');
});

// Emitir `location: undefined` hacía que el upsert lo escribiera como NULL,
// borrando el lugar que la fila ya tenía. La clave se omite.
test('una ficha sin lugar no manda la clave location', () => {
  const html = `<aside id="detailDrawer"><h1>Persona Prueba Uno</h1>
    <dl><dt>Estado</dt><dd>Por localizar</dd></dl></aside>`;
  const { update } = toUpdate(parsePersonPage(html, PAGE_URL), PAGE_URL);
  assert.ok(!('location' in update), 'no debe viajar la clave si no hay dato');
});

// Si ese vocabulario cambia, esto falla acá y no contra la API en producción.
test('el status y el source que produce son los que la API acepta', () => {
  const etiquetas = ['Por localizar', 'Localizada', 'No localizada', 'Algo inesperado', undefined, ''];
  for (const e of etiquetas) {
    assert.ok(STATUSES.includes(mapStatus(e)), `status inválido para ${JSON.stringify(e)}`);
  }
  const { update } = toUpdate(parsePersonPage(fichaHtml(), PAGE_URL), PAGE_URL);
  assert.ok(SOURCES.includes(update.source));
});

test('toUpdate sobre una ficha ilegible devuelve null', () => {
  assert.strictEqual(toUpdate(null, PAGE_URL), null);
});

test('personIdFromUrl y canonicalPersonUrl son inversas', () => {
  assert.strictEqual(personIdFromUrl(PAGE_URL), UUID);
  assert.strictEqual(canonicalPersonUrl(UUID), PAGE_URL);
  assert.strictEqual(personIdFromUrl('https://colombiatebusca.com/'), undefined);
  assert.strictEqual(personIdFromUrl(undefined), undefined);
});
