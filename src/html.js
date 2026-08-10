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

const PRIVACY_NOTE = `<p class="privacy">🔒 Las fotos <strong>nunca</strong> se comparten ni se muestran a nadie: solo se usan para reconocimiento facial y el aviso de coincidencia llega sin fotos.</p>`;

// Client-side downscale before upload: keeps payloads small enough for
// serverless limits and slow connections.
const RESIZE_SCRIPT = `<script>
document.addEventListener('submit', async function (ev) {
  var form = ev.target;
  if (!form.matches('form[data-resize-photos]') || form.dataset.resized) return;
  var inputs = form.querySelectorAll('input[type=file]');
  var hasFiles = Array.prototype.some.call(inputs, function (i) { return i.files.length; });
  if (!hasFiles || typeof createImageBitmap !== 'function') return;
  ev.preventDefault();
  for (var input of inputs) {
    var dt = new DataTransfer();
    for (var file of input.files) {
      try {
        var bmp = await createImageBitmap(file);
        var scale = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(bmp.width * scale);
        canvas.height = Math.round(bmp.height * scale);
        canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
        var blob = await new Promise(function (r) { canvas.toBlob(r, 'image/jpeg', 0.82); });
        dt.items.add(new File([blob], (file.name || 'foto') + '.jpg', { type: 'image/jpeg' }));
      } catch (e) { dt.items.add(file); }
    }
    input.files = dt.files;
  }
  form.dataset.resized = '1';
  if (form.requestSubmit) form.requestSubmit(); else form.submit();
});
</script>`;

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
<div class="tricolor"><span class="y"></span><span class="b"></span><span class="r"></span></div>
<header>
  <a class="brand" href="/">📍 Aquí</a>
  <nav>
    <a href="/buscar">Buscar</a>
    <a href="/report" class="cta">Reportar estado</a>
  </nav>
</header>
<div class="banner">🇨🇴 <strong>Terremoto en Colombia — lunes 10 de agosto.</strong> Reporta y encuentra personas.</div>
<main>
${body}
</main>
<footer>
  <p>Aquí — información de personas en emergencias. Las fotos que subas nunca se comparten ni se muestran: solo se usan para reconocimiento facial.</p>
  <p><a href="/privacidad">Política de privacidad</a> · <a href="/terminos">Términos de servicio</a></p>
</footer>
${RESIZE_SCRIPT}
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

function mapLink(u) {
  if (u.lat == null || u.lng == null) return '';
  return ` · <a href="https://www.openstreetmap.org/?mlat=${u.lat}&amp;mlon=${u.lng}#map=16/${u.lat}/${u.lng}" target="_blank" rel="noopener">ver en mapa</a>`;
}

function updateCard(u, personName) {
  return `<article class="card">
  ${personName ? `<h3><a href="/person/${u.person_id}">${esc(personName)}</a></h3>` : ''}
  <p>${statusBadge(u.status)} <time>${fmtDate(u.created_at)}</time></p>
  ${u.message ? `<p class="msg">${esc(u.message)}</p>` : ''}
  ${u.location ? `<p class="loc">📍 ${esc(u.location)}${mapLink(u)}</p>` : u.lat != null && u.lng != null ? `<p class="loc">📍 Ubicación GPS${mapLink(u)}</p>` : ''}
  <p class="meta">Fuente: ${esc(u.source)}${u.reporter ? ` · Reportado por: ${esc(u.reporter)}` : ''}</p>
</article>`;
}

const LOCATION_SCRIPT = `<script>
(function () {
  var btn = document.getElementById('geo-btn');
  if (btn) btn.addEventListener('click', function () {
    if (!navigator.geolocation) { btn.textContent = 'GPS no disponible en este navegador'; return; }
    btn.textContent = '📍 Obteniendo ubicación…';
    navigator.geolocation.getCurrentPosition(function (pos) {
      document.getElementById('lat').value = pos.coords.latitude.toFixed(6);
      document.getElementById('lng').value = pos.coords.longitude.toFixed(6);
      btn.textContent = '✅ Ubicación compartida';
      fetch('https://nominatim.openstreetmap.org/reverse?format=json&lat=' + pos.coords.latitude + '&lon=' + pos.coords.longitude)
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var loc = document.getElementById('location');
          if (d.display_name && !loc.value) loc.value = d.display_name.split(',').slice(0, 4).join(',');
        }).catch(function () {});
    }, function () { btn.textContent = 'No se pudo obtener la ubicación'; });
  });

  var loc = document.getElementById('location');
  var list = document.getElementById('location-options');
  var timer;
  if (loc && list) loc.addEventListener('input', function () {
    clearTimeout(timer);
    var q = loc.value.trim();
    if (q.length < 4) return;
    timer = setTimeout(function () {
      fetch('https://nominatim.openstreetmap.org/search?format=json&countrycodes=co&limit=5&q=' + encodeURIComponent(q))
        .then(function (r) { return r.json(); })
        .then(function (results) {
          list.innerHTML = '';
          results.forEach(function (r) {
            var o = document.createElement('option');
            o.value = r.display_name.split(',').slice(0, 4).join(',');
            list.appendChild(o);
          });
        }).catch(function () {});
    }, 400);
  });
})();
</script>`;

module.exports = { esc, layout, statusBadge, updateCard, fmtDate, PRIVACY_NOTE, LOCATION_SCRIPT };
