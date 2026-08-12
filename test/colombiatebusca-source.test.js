const test = require('node:test');
const assert = require('node:assert');
const {
  personUrlsFromSitemap,
  parsePersonPage,
  toUpdate,
  mapStatus,
  mapSex,
  parseAge,
  parseRegisteredAt
} = require('../src/sources/colombiatebusca');

// HTML sintético con la forma de una ficha real: un <aside id="detailDrawer">
// con <h1>, una <img> a media.php y una lista de pares <dt>/<dd>. Los nombres
// son inventados (regla dura del repo: nunca datos personales reales).
function fichaHtml(overrides = {}) {
  const f = {
    nombre: 'Persona Prueba Uno',
    estado: 'Por localizar',
    codigo: 'CTB-0001',
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
        <dt>C&oacute;digo</dt><dd>${f.codigo}</dd>
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

const PAGE_URL = 'https://colombiatebusca.com/?person=11111111-2222-3333-4444-555555555555';

test('el sitemap entrega las URLs de ficha en orden', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <urlset>
      <url><loc>https://colombiatebusca.com/</loc></url>
      <url><loc>https://colombiatebusca.com/?person=aaaaaaaa-1111-2222-3333-444444444444</loc></url>
      <url><loc>https://colombiatebusca.com/?person=bbbbbbbb-1111-2222-3333-444444444444</loc></url>
      <url><loc>https://colombiatebusca.com/contacto.php</loc></url>
    </urlset>`;
  assert.deepStrictEqual(personUrlsFromSitemap(xml), [
    'https://colombiatebusca.com/?person=aaaaaaaa-1111-2222-3333-444444444444',
    'https://colombiatebusca.com/?person=bbbbbbbb-1111-2222-3333-444444444444'
  ]);
});

test('el sitemap sin fichas devuelve una lista vacía, no revienta', () => {
  assert.deepStrictEqual(personUrlsFromSitemap('<urlset></urlset>'), []);
  assert.deepStrictEqual(personUrlsFromSitemap(''), []);
});

test('una ficha entrega nombre, foto absoluta y sus campos', () => {
  const parsed = parsePersonPage(fichaHtml(), PAGE_URL);
  assert.strictEqual(parsed.fullName, 'Persona Prueba Uno');
  // La <img> viene relativa; se resuelve contra la URL de la página.
  assert.strictEqual(parsed.photoUrl, 'https://colombiatebusca.com/media.php?id=abc123&type=full');
  assert.strictEqual(parsed.fields['Estado'], 'Por localizar');
  assert.strictEqual(parsed.fields['Último lugar visto'], 'Barrio Ejemplo, Qubdó');
  assert.strictEqual(parsed.fields['Categoría'], 'Desaparición forzada');
});

test('una página sin cajón de detalle o sin nombre se salta', () => {
  assert.strictEqual(parsePersonPage('<html><body>Nada</body></html>', PAGE_URL), null);
  assert.strictEqual(parsePersonPage(fichaHtml({ nombre: '' }), PAGE_URL), null);
});

test('el número de documento censurado nunca sale del módulo', () => {
  const { update, details } = toUpdate(parsePersonPage(fichaHtml(), PAGE_URL), PAGE_URL);
  const serialized = JSON.stringify({ update, details });
  assert.ok(!serialized.includes('656'), 'el documento parcial no debe viajar en la salida');
  assert.ok(!/documento/i.test(serialized), 'ninguna clave ni valor debe mencionar el documento');
});

test('"Por localizar" es missing y "Localizada" es safe', () => {
  assert.strictEqual(mapStatus('Por localizar'), 'missing');
  assert.strictEqual(mapStatus('Localizada'), 'safe');
  assert.strictEqual(mapStatus('Localizado'), 'safe');
  // Un estado que no reconocemos NO se adivina: cae a unknown, que es un
  // estado válido de la app, en vez de inventar "missing" o "safe".
  assert.strictEqual(mapStatus('En verificación'), 'unknown');
  assert.strictEqual(mapStatus(undefined), 'unknown');
});

test('edad y género se leen; lo que no viene queda indefinido', () => {
  assert.strictEqual(parseAge('34 años'), 34);
  assert.strictEqual(parseAge('Sin dato'), undefined);
  assert.strictEqual(parseAge(undefined), undefined);
  assert.strictEqual(mapSex('Femenino'), 'f');
  assert.strictEqual(mapSex('Masculino'), 'm');
  assert.strictEqual(mapSex('No binario'), 'otro');
  assert.strictEqual(mapSex(undefined), undefined);
});

test('la fecha de registro se interpreta en hora de Colombia', () => {
  // 05:51 PM en UTC-5 son las 22:51 UTC del mismo día.
  assert.strictEqual(parseRegisteredAt('10/08/2026 05:51 PM').toISOString(), '2026-08-10T22:51:00.000Z');
  assert.strictEqual(parseRegisteredAt('10/08/2026 09:05 AM').toISOString(), '2026-08-10T14:05:00.000Z');
  // Medianoche y mediodía son donde el %12 se equivoca si está mal escrito.
  assert.strictEqual(parseRegisteredAt('10/08/2026 12:00 AM').toISOString(), '2026-08-10T05:00:00.000Z');
  assert.strictEqual(parseRegisteredAt('10/08/2026 12:00 PM').toISOString(), '2026-08-10T17:00:00.000Z');
  assert.strictEqual(parseRegisteredAt('sin fecha'), undefined);
});

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

test('el status y el source que produce son los que la API acepta', () => {
  const { STATUSES, SOURCES } = require('../src/people');
  for (const estado of ['Por localizar', 'Localizada', 'Algo inesperado', undefined]) {
    assert.ok(STATUSES.includes(mapStatus(estado)), `status inválido para "${estado}"`);
  }
  const { update } = toUpdate(parsePersonPage(fichaHtml(), PAGE_URL), PAGE_URL);
  assert.ok(SOURCES.includes(update.source));
});

test('external_id es estable entre lecturas de la misma ficha', () => {
  const a = toUpdate(parsePersonPage(fichaHtml(), PAGE_URL), PAGE_URL).update;
  // La misma ficha, ya localizada: cambia el estado, no la identidad.
  const b = toUpdate(parsePersonPage(fichaHtml({ estado: 'Localizada' }), PAGE_URL), PAGE_URL).update;
  assert.strictEqual(a.external_id, b.external_id);
  assert.strictEqual(a.status, 'missing');
  assert.strictEqual(b.status, 'safe');
});

test('toUpdate sobre una ficha ilegible devuelve null', () => {
  assert.strictEqual(toUpdate(null, PAGE_URL), null);
});
