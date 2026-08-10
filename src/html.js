// Minimal server-rendered HTML helpers. No client framework: emergency sites
// must load fast on bad connections and old phones.
const { STATUS_LABEL } = require('./notify');

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STATUS_CLASS = {
  safe: 'ok',
  injured: 'warn',
  missing: 'bad',
  deceased: 'grave',
  unknown: 'muted'
};

function layout(title, body) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Aquí</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<header>
  <a class="brand" href="/">📍 Aquí</a>
  <nav>
    <a href="/">Buscar</a>
    <a href="/report" class="cta">Reportar estado</a>
  </nav>
</header>
<main>
${body}
</main>
<footer>
  <p>Aquí — información de personas en emergencias. También por WhatsApp: escribe <strong>AYUDA</strong> a nuestro número.</p>
</footer>
</body>
</html>`;
}

function statusBadge(status) {
  return `<span class="badge ${STATUS_CLASS[status] || 'muted'}">${esc(
    STATUS_LABEL[status] || status
  )}</span>`;
}

function fmtDate(iso) {
  return esc((iso || '').replace('T', ' ').replace('Z', ' UTC'));
}

function updateCard(u, personName) {
  return `<article class="card">
  ${personName ? `<h3><a href="/person/${u.person_id}">${esc(personName)}</a></h3>` : ''}
  <p>${statusBadge(u.status)} <time>${fmtDate(u.created_at)}</time></p>
  ${u.message ? `<p class="msg">${esc(u.message)}</p>` : ''}
  ${u.location ? `<p class="loc">📍 ${esc(u.location)}</p>` : ''}
  <p class="meta">Fuente: ${esc(u.source)}${u.reporter ? ` · Reportado por: ${esc(u.reporter)}` : ''}</p>
</article>`;
}

module.exports = { esc, layout, statusBadge, updateCard, fmtDate };
