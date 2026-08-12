// Lector del registro público de Colombia Te Busca (colombiatebusca.com), el
// otro registro donde las familias publican a sus desaparecidos. La app ya lo
// nombra como fuente en la lista de reportes ("Fuentes de información de
// desaparecidos: Encontrados.co y Colombia Te Busca", src/routes/web.js), y el
// pie de cada página ofrece integrarse con ellos (OUTREACH en src/html.js).
// Esto es el código que hace cierta esa frase.
//
// Este módulo SOLO convierte HTML en datos. No trae nada de la red, no escribe
// en la base y no decide cada cuánto correr: recibe el texto de una página y
// devuelve un objeto. Quien lo llame decide el resto. Así se puede probar
// entero sin red y sin servicios externos, como el resto de los tests.
//
// Qué se puede leer, según su robots.txt (revisado 12-ago-2026):
//
//   - `/sitemap.php` está PERMITIDO y enumera cada ficha como
//     `<loc>https://colombiatebusca.com/?person=<uuid></loc>`. Es, de hecho, el
//     índice completo del registro, sin necesidad de paginar.
//   - `?person=<uuid>` está PERMITIDO y renderiza en el servidor, sin JS, un
//     `<aside id="detailDrawer">` con el nombre, la foto y una lista de pares
//     etiqueta/valor.
//   - `/core.php` (el listado filtrable que usa su interfaz), `/admin/`,
//     `/login.php` y `/estado.php` están PROHIBIDOS. Este módulo no los toca,
//     ni siquiera para leer.
//
// Se parsea con expresiones regulares en vez de un parser de HTML a propósito:
// es una sola fuente, con una estructura plana y acotada, y agregar una
// dependencia nueva para esto no se justifica (ver CONTRIBUTING). Si su
// estructura cambia, o si aparece una segunda fuente en HTML, vale reconsiderarlo.
//
// LO QUE ENTRA ES HOSTIL POR DEFECTO. El HTML viene de un sitio que no
// controlamos, así que toda función acá tiene que aguantar entrada mal formada
// sin lanzar: el contrato es "una ficha ilegible se salta, no revienta el
// barrido completo". Varias de las decisiones de abajo existen solo por eso.

const ORIGIN = 'https://colombiatebusca.com';
const SITEMAP_URL = `${ORIGIN}/sitemap.php`;
const HOST = 'colombiatebusca.com';

// El campo "Documento" de sus fichas llega siempre censurado a medias
// ("*****656", o "Sin documento público"). Se descarta DENTRO de
// parsePersonPage, no más abajo: las dos funciones están exportadas, así que
// dejar el filtro solo en toUpdate significaba que un consumidor que llamara
// parsePersonPage recibía el dato igual. Media cédula no identifica a nadie y
// sí es un dato personal que este repo no tiene por qué cargar.
const DROPPED_LABELS = /documento|c[eé]dula|nuip|identificaci[oó]n/i;

// Object.create(null): con un objeto literal, `name in named` camina la cadena
// de prototipos y `&toString;` se reemplazaba por el código fuente de
// Object.prototype.toString. Sin prototipo no hay cadena que caminar.
const NAMED_ENTITIES = Object.assign(Object.create(null), {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  ntilde: 'ñ', uuml: 'ü',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  Ntilde: 'Ñ', Uuml: 'Ü'
});

const MAX_CODE_POINT = 0x10ffff;

// String.fromCodePoint lanza RangeError sobre cualquier valor por encima de
// U+10FFFF o dentro del rango de sustitutos. Una entidad numérica basura en el
// HTML de origen bastaba para tumbar el parseo de la ficha entera.
function codePointToChar(value) {
  if (!Number.isFinite(value) || value < 0 || value > MAX_CODE_POINT) return '';
  if (value >= 0xd800 && value <= 0xdfff) return '';
  try {
    return String.fromCodePoint(value);
  } catch {
    return '';
  }
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (whole, code) => codePointToChar(Number(code)) || whole)
    .replace(/&#x([0-9a-f]+);/gi, (whole, code) => codePointToChar(parseInt(code, 16)) || whole)
    .replace(/&([a-z]+);/gi, (whole, name) =>
      Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : whole
    );
}

// Texto legible a partir de un fragmento de HTML.
//
// El orden importa y antes estaba al revés: se quitaban las etiquetas y DESPUÉS
// se decodificaban las entidades, así que cualquier marcado que la fuente
// hubiera codificado (`&lt;img src=x onerror=...&gt;`) sobrevivía intacto al
// barrido y volvía a materializarse como etiqueta dentro del nombre. Se decodifica
// en medio y se vuelve a barrer. El separador es un espacio, no cadena vacía:
// pegar `<b>Ana</b><i>Ruiz</i>` sin separador producía "AnaRuiz".
function htmlToText(fragment) {
  const stripped = String(fragment).replace(/<[^>]*>/g, ' ');
  const decoded = decodeEntities(stripped);
  return decoded
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** El uuid de una URL de ficha (`?person=<uuid>`), o undefined si no lo trae. */
function personIdFromUrl(url) {
  const m = String(url == null ? '' : url).match(/[?&]person=([a-f0-9-]+)/i);
  return m ? m[1].toLowerCase() : undefined;
}

/** URL canónica de una ficha a partir de su uuid. Es lo que viaja como
 *  `external_id`, y por eso tiene que ser estable: derivarla del uuid en vez de
 *  usar la URL cruda hace que `http://` vs `https://`, un `index.php` de más o
 *  un parámetro de rastreo pegado al final no produzcan dos llaves distintas
 *  para la misma persona. Con llaves distintas el upsert deja de actualizar y
 *  empieza a insertar. */
function canonicalPersonUrl(personId) {
  return `${ORIGIN}/?person=${personId}`;
}

// Las URLs de ficha que anuncia su sitemap, en el orden en que vienen. Las
// fichas nuevas entran al principio, así que ese orden es información: quien
// barra puede parar temprano.
//
// Se valida origen y esquema. Antes bastaba con que el texto del <loc>
// contuviera `?person=<hex>`, así que un sitemap alterado —o simplemente un
// enlace a otro dominio— entregaba URLs de terceros que el consumidor iba a ir
// a buscar creyendo que eran fichas.
function personUrlsFromSitemap(sitemapXml) {
  const urls = [];
  const seen = new Set();
  const re = /<loc>([\s\S]*?)<\/loc>/gi;
  let m;
  while ((m = re.exec(String(sitemapXml))) !== null) {
    const raw = decodeEntities(m[1]).trim();
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
    if (parsed.hostname.toLowerCase() !== HOST) continue;
    const personId = personIdFromUrl(parsed.search);
    if (!personId || seen.has(personId)) continue;
    seen.add(personId);
    urls.push(canonicalPersonUrl(personId));
  }
  return urls;
}

// Extrae el cajón de detalle de una ficha. Devuelve null si la página no trae
// uno reconocible o no trae nombre — una ficha ilegible se salta, no revienta
// el barrido completo.
function parsePersonPage(html, pageUrl) {
  const drawer = String(html).match(/<aside[^>]*id="detailDrawer"[^>]*>([\s\S]*?)<\/aside>/i);
  if (!drawer) return null;
  const inner = drawer[1];

  const nameMatch = inner.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const fullName = nameMatch ? htmlToText(nameMatch[1]) : '';
  if (!fullName) return null;

  const photoMatch = inner.match(/<img[^>]*src="([^"]*media\.php[^"]*)"/i);
  let photoUrl;
  if (photoMatch) {
    try {
      const resolved = new URL(decodeEntities(photoMatch[1]), pageUrl || ORIGIN);
      // Misma razón que en el sitemap: la foto se va a ir a bajar, así que no
      // se acepta que la ficha apunte a otro dominio.
      if (resolved.hostname.toLowerCase() === HOST) photoUrl = resolved.toString();
    } catch {
      photoUrl = undefined;
    }
  }

  const fields = Object.create(null);
  const pairRe = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi;
  let pair;
  while ((pair = pairRe.exec(inner)) !== null) {
    // Etiqueta y valor pasan por el MISMO normalizador. Antes la etiqueta solo
    // se recortaba en los extremos mientras el valor sí colapsaba espacios, así
    // que un `<dt>` que el servidor imprimiera partido en dos líneas nunca
    // volvía a coincidir con las búsquedas por texto exacto de toUpdate.
    const label = htmlToText(pair[1]);
    const value = htmlToText(pair[2]);
    if (!label) continue;
    if (DROPPED_LABELS.test(label)) continue;
    fields[label] = value;
  }

  return { fullName, photoUrl, fields };
}

// Su "Estado" es binario: "Por localizar" o "Localizada".
//
// La traducción es por etiqueta COMPLETA, no por substring. Antes preguntaba si
// el texto contenía "localizad", y esa forma se rompe en la dirección peligrosa:
// "No localizada" contiene "localizad", así que una persona que sigue
// desaparecida se publicaba como `safe` — se cae del listado de desaparecidos,
// entra al conteo de reencontradas, y a cada familia suscrita le llega un aviso
// de que su familiar apareció. Una edición de copy de una palabra del lado de
// ellos bastaba para dispararlo.
//
// Lo que no reconocemos cae a `unknown`, que es un estado válido de la app.
// Incluye "Localizada sin vida": la app tiene `deceased`, pero traducir a ese
// valor una etiqueta que nunca hemos visto es adivinar sobre la muerte de
// alguien. `unknown` deja que lo mire una persona.
const STATUS_BY_LABEL = Object.assign(Object.create(null), {
  'por localizar': 'missing',
  localizada: 'safe',
  localizado: 'safe'
});

function normalizeLabel(value) {
  return String(value == null ? '' : value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function mapStatus(estado) {
  const key = normalizeLabel(estado);
  if (!key) return 'unknown';
  return Object.prototype.hasOwnProperty.call(STATUS_BY_LABEL, key) ? STATUS_BY_LABEL[key] : 'unknown';
}

function mapSex(genero) {
  const n = normalizeLabel(genero);
  if (!n) return undefined;
  if (n.startsWith('masc')) return 'm';
  if (n.startsWith('fem')) return 'f';
  return 'otro';
}

function parseAge(edad) {
  if (edad == null) return undefined;
  const m = String(edad).match(/(\d+)/);
  if (!m) return undefined;
  const age = Number(m[1]);
  return Number.isFinite(age) && age >= 0 && age <= 130 ? age : undefined;
}

function isRealCalendarDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

// "10/08/2026 05:51 PM" — DD/MM/YYYY hh:mm AM/PM en hora de Colombia (UTC-5,
// sin horario de verano). Se arma a mano porque `new Date(texto)` no parsea
// este formato de forma confiable y, cuando falla, falla en silencio.
function parseRegisteredAt(value) {
  if (value == null) return undefined;
  const m = String(value).match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return undefined;
  const [, dd, mm, yyyy, hh, min, meridiem] = m;
  const hour12 = Number(hh);
  if (hour12 < 1 || hour12 > 12) return undefined;
  let hour = hour12 % 12;
  if (meridiem.toUpperCase() === 'PM') hour += 12;
  // `new Date` acomoda un 31/02 corriéndolo a marzo sin quejarse, así que el
  // calendario se valida ANTES de construir la fecha. No sirve comparar los
  // campos de vuelta: la fecha se arma en UTC-5, así que su día en UTC es otro
  // a partir de las 7 de la noche y la comparación daría falsos negativos.
  if (!isRealCalendarDate(Number(yyyy), Number(mm), Number(dd))) return undefined;
  const date = new Date(`${yyyy}-${mm}-${dd}T${String(hour).padStart(2, '0')}:${min}:00-05:00`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

// Convierte una ficha parseada al cuerpo de POST /api/updates.
//
// Solo mapea campos que existen en las dos puntas. Lo demás (edad, género,
// categoría, foto, fecha de registro) sale aparte en `details`, sin inventar
// texto que un usuario terminaría leyendo: qué hacer con esos datos es una
// decisión de producto, y quien llame la toma con el diff a la vista.
//
// Devuelve null sin `pageUrl` utilizable. Antes tomaba el argumento tal cual, así
// que llamarlo sin él producía un cuerpo con `external_id: undefined` — sin
// error y sin aviso. Como `external_id` es justamente la llave del upsert, ese
// cuerpo insertaba una fila nueva en cada barrido en vez de actualizar la que ya
// estaba, y en un registro sin borrado por API eso no se deshace.
//
// ⚠️ Nota de integración para quien lo conecte: el upsert de `POST /api/updates`
// hace `message = EXCLUDED.message` y `location = EXCLUDED.location`, así que
// republicar una ficha que perdió su "Último lugar visto" BORRA el que la fila
// ya tenía. Este módulo no puede arreglarlo desde acá —es semántica del
// endpoint— pero quien lo llame tiene que saberlo antes de programarlo en un
// barrido periódico.
function toUpdate(parsed, pageUrl) {
  if (!parsed) return null;
  const personId = personIdFromUrl(pageUrl);
  if (!personId) return null;

  const f = parsed.fields || {};
  const location = f['Último lugar visto'];
  return {
    update: {
      name: parsed.fullName,
      status: mapStatus(f['Estado']),
      ...(location ? { location } : {}),
      // El registro de origen es quien reporta, no quien corre el proceso.
      // Ojo al mostrarlo: maskReporter() está pensado para nombres de persona
      // (nombre + inicial), así que en las vistas públicas esto sale como
      // "Colombia T.". Arreglarlo cambia lo que ve un usuario, así que va por
      // issue aparte y no acá.
      reporter: 'Colombia Te Busca',
      source: 'aggregator',
      external_id: canonicalPersonUrl(personId)
    },
    details: {
      rawStatus: f['Estado'] || undefined,
      category: f['Categoría'] || undefined,
      age: parseAge(f['Edad']),
      sex: mapSex(f['Género']),
      photoUrl: parsed.photoUrl,
      registeredAt: parseRegisteredAt(f['Registrado'])
    }
  };
}

module.exports = {
  ORIGIN,
  SITEMAP_URL,
  personUrlsFromSitemap,
  personIdFromUrl,
  canonicalPersonUrl,
  parsePersonPage,
  toUpdate,
  mapStatus,
  mapSex,
  parseAge,
  parseRegisteredAt
};
