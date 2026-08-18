// Los 32 departamentos de Colombia (DANE) más Bogotá D.C., que no es
// departamento pero es la unidad que cualquier persona escribiría en un
// formulario. Lista fija a propósito: es lo único que valida el campo
// `department` en updates, así que un valor fuera de esta lista se descarta
// en vez de guardarse como texto libre (ver report-admission.js).
//
// PENDIENTE — solo el formulario web de /report pide este campo hoy:
//   - POST /api/updates lo ACEPTA (src/routes/api.js) pero nada se lo manda
//     todavía: haría falta avisarle a quien integra el API (agregadores,
//     etc.) de que existe, antes de pensar en exigirlo — hacerlo ya
//     rechazaría de golpe reportes que hoy entran bien.
//   - El bot de WhatsApp (src/bot.js) no tiene NINGÚN lugar en su gramática
//     de comandos para expresarlo — agregar uno es una decisión de producto
//     aparte (qué sintaxis, cómo se explica en AYUDA), no un cambio chico.
//   - Recién cuando los tres caminos (web, API, WhatsApp) puedan mandarlo,
//     tiene sentido volver a report-admission.js y exigirlo de verdad en vez
//     de degradarlo a null en silencio (evaluateMerge, src/people.js, ya
//     asume que puede faltar y no rompe nada cuando falta).
const DEPARTMENTS = [
  'Amazonas',
  'Antioquia',
  'Arauca',
  'Atlántico',
  'Bogotá D.C.',
  'Bolívar',
  'Boyacá',
  'Caldas',
  'Caquetá',
  'Casanare',
  'Cauca',
  'Cesar',
  'Chocó',
  'Córdoba',
  'Cundinamarca',
  'Guainía',
  'Guaviare',
  'Huila',
  'La Guajira',
  'Magdalena',
  'Meta',
  'Nariño',
  'Norte de Santander',
  'Putumayo',
  'Quindío',
  'Risaralda',
  'San Andrés y Providencia',
  'Santander',
  'Sucre',
  'Tolima',
  'Valle del Cauca',
  'Vaupés',
  'Vichada'
];

const DEPARTMENT_SET = new Set(DEPARTMENTS);

// Cualquier valor fuera de la lista fija (incluido vacío o mal escrito) se
// descarta a null, en vez de guardarse como texto libre — el punto de tener
// una lista es que "Antioquia" siempre se escriba igual, para poder
// comparase por igualdad exacta más adelante (findOrCreatePerson).
function cleanDepartment(value) {
  const raw = String(value || '').trim();
  return DEPARTMENT_SET.has(raw) ? raw : null;
}

module.exports = { DEPARTMENTS, cleanDepartment };
