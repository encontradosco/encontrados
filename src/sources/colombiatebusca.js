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

const ORIGIN = 'https://colombiatebusca.com';
const SITEMAP_URL = `${ORIGIN}/sitemap.php`;

// El campo "Documento" de sus fichas llega siempre censurado a medias
// ("*****656", o "Sin documento público"). No se lee, no se guarda y no se
// devuelve: media cédula no sirve para identificar a nadie y sí es un dato
// personal que este repo no tiene por qué cargar.

function decodeEntities(s) {
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    aacute: 'á',
    eacute: 'é',
    iacute: 'í',
    oacute: 'ó',
    uacute: 'ú',
    ntilde: 'ñ',
    uuml: 'ü',
    Aacute: 'Á',
    Eacute: 'É',
    Iacute: 'Í',
    Oacute: 'Ó',
    Uacute: 'Ú',
    Ntilde: 'Ñ',
    Uuml: 'Ü'
  };
  return String(s)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (whole, name) => (name in named ? named[name] : whole));
}

// Las URLs de ficha que anuncia su sitemap, en el orden en que vienen. Las
// fichas nuevas entran al principio, así que ese orden es información: quien
// barra puede parar temprano.
function personUrlsFromSitemap(sitemapXml) {
  const urls = [];
  const re = /<loc>\s*([^<\s]*\?person=[a-f0-9-]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(String(sitemapXml))) !== null) {
    urls.push(decodeEntities(m[1]));
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
  const fullName = nameMatch ? decodeEntities(nameMatch[1].replace(/<[^>]+>/g, '')).trim() : '';
  if (!fullName) return null;

  const photoMatch = inner.match(/<img[^>]*src="([^"]*media\.php[^"]*)"/i);
  let photoUrl;
  if (photoMatch) {
    try {
      photoUrl = new URL(decodeEntities(photoMatch[1]), pageUrl || ORIGIN).toString();
    } catch {
      photoUrl = undefined;
    }
  }

  const fields = {};
  const pairRe = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi;
  let pair;
  while ((pair = pairRe.exec(inner)) !== null) {
    const label = decodeEntities(pair[1].replace(/<[^>]+>/g, '')).trim();
    // El valor puede venir envuelto en un <span class="badge">; se pela.
    const value = decodeEntities(pair[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (label) fields[label] = value;
  }

  return { fullName, photoUrl, fields };
}

// Su "Estado" es binario: "Por localizar" o "Localizada". El nuestro tiene
// cinco valores, así que la traducción pierde precisión en una dirección
// concreta y conviene decirlo: "Localizada" se traduce a `safe`, pero ese
// registro no distingue a quien apareció con vida de quien no. Un fallecimiento
// se confirma casi siempre por un canal oficial (Medicina Legal), no por una
// plataforma ciudadana de "avísenme si aparece" — por eso `safe` es la lectura
// razonable, pero es una inferencia. El texto original viaja en `details.rawStatus`
// para que se pueda auditar.
function mapStatus(estado) {
  if (!estado) return 'unknown';
  const normalized = String(estado).toLowerCase();
  if (normalized.includes('localizad')) return 'safe';
  if (normalized.includes('por localizar')) return 'missing';
  return 'unknown';
}

function mapSex(genero) {
  if (!genero) return undefined;
  const normalized = String(genero).toLowerCase();
  if (normalized.startsWith('masc')) return 'm';
  if (normalized.startsWith('fem')) return 'f';
  return 'otro';
}

function parseAge(edad) {
  if (!edad) return undefined;
  const m = String(edad).match(/(\d+)/);
  return m ? Number(m[1]) : undefined;
}

// "10/08/2026 05:51 PM" — DD/MM/YYYY hh:mm AM/PM en hora de Colombia (UTC-5,
// sin horario de verano). Se arma a mano porque `new Date(texto)` no parsea
// este formato de forma confiable y, cuando falla, falla en silencio.
function parseRegisteredAt(value) {
  if (!value) return undefined;
  const m = String(value).match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return undefined;
  const [, dd, mm, yyyy, hh, min, meridiem] = m;
  let hour = Number(hh) % 12;
  if (meridiem.toUpperCase() === 'PM') hour += 12;
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
// `external_id` es la URL de la ficha, que es su identificador estable: volver
// a publicar la misma ficha actualiza la misma entrada en vez de duplicarla.
// `reporter` es el registro de origen, no quien corre el proceso: el dato es
// suyo y la atribución le corresponde.
function toUpdate(parsed, pageUrl) {
  if (!parsed) return null;
  const f = parsed.fields || {};
  return {
    update: {
      name: parsed.fullName,
      status: mapStatus(f['Estado']),
      location: f['Último lugar visto'] || undefined,
      reporter: 'Colombia Te Busca',
      source: 'aggregator',
      external_id: pageUrl
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
  parsePersonPage,
  toUpdate,
  mapStatus,
  mapSex,
  parseAge,
  parseRegisteredAt
};
