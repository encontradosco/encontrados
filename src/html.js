// Minimal server-rendered HTML helpers. No client framework: emergency sites
// must load fast on bad connections and old phones.
const env = require('./env');
const { STATUS_LABEL } = require('./notify');

const DEFAULT_DESCRIPTION =
  'Busca/reporta perdidos usando reconocimiento facial. Tras el terremoto en Colombia del 10 de agosto. Información provista por voluntarios y extraída de bases de datos públicas.';

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

// Client-side downscale + XHR upload with a visible progress bar. Emergency
// users on weak connections must see that something is happening.
const RESIZE_SCRIPT = `<script>
(function () {
  function bar(form) {
    var box = form.querySelector('.upload-progress');
    if (!box) {
      box = document.createElement('div');
      box.className = 'upload-progress';
      box.innerHTML = '<div class="upload-label">Preparando…</div><div class="upload-track"><div class="upload-fill"></div></div>';
      form.appendChild(box);
    }
    box.style.display = 'block';
    return {
      set: function (pct, label) {
        box.querySelector('.upload-fill').style.width = Math.max(2, Math.round(pct)) + '%';
        if (label) box.querySelector('.upload-label').textContent = label;
      },
      hide: function () { box.style.display = 'none'; }
    };
  }

  async function shrink(file) {
    if (typeof createImageBitmap !== 'function') return file;
    try {
      var bmp = await createImageBitmap(file);
      var scale = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      var blob = await new Promise(function (r) { canvas.toBlob(r, 'image/jpeg', 0.82); });
      return new File([blob], (file.name || 'foto') + '.jpg', { type: 'image/jpeg' });
    } catch (e) { return file; }
  }

  document.addEventListener('submit', async function (ev) {
    var form = ev.target;
    if (!form.matches('form[data-resize-photos]')) return;
    var inputs = form.querySelectorAll('input[type=file]');
    var files = [];
    inputs.forEach(function (i) { for (var f of i.files) files.push(f); });
    if (!files.length) return; // plain submit, no upload UI needed

    ev.preventDefault();
    var submitBtn = form.querySelector('button:not([type=button])');
    if (submitBtn) { submitBtn.disabled = true; }
    var p = bar(form);

    // 1) shrink (0-30%)
    var data = new FormData(form);
    inputs.forEach(function (i) { data.delete(i.name); });
    var done = 0;
    for (var input of inputs) {
      for (var file of input.files) {
        p.set(5 + (done / files.length) * 25, 'Optimizando foto ' + (done + 1) + ' de ' + files.length + '…');
        data.append(input.name, await shrink(file));
        done++;
      }
    }

    // 2) upload (30-100%)
    p.set(30, 'Enviando… 0%');
    var requestUrl = new URL(form.getAttribute('action') || location.href, location.href).href;
    var xhr = new XMLHttpRequest();
    xhr.open(form.method || 'POST', requestUrl);
    xhr.upload.onprogress = function (e) {
      if (!e.lengthComputable) return;
      var pct = e.loaded / e.total;
      p.set(30 + pct * 65, 'Enviando… ' + Math.round(pct * 100) + '%');
    };
    xhr.onload = function () {
      p.set(100, '¡Listo!');
      // Only navigate when the server actually redirected us somewhere else.
      // For a page rendered in place (e.g. search results) responseURL equals
      // the request URL, and navigating there would discard the results.
      if (xhr.responseURL && xhr.responseURL.split('#')[0] !== requestUrl.split('#')[0]) {
        window.location.href = xhr.responseURL;
        return;
      }
      document.open();
      document.write(xhr.responseText);
      document.close();
    };
    xhr.onerror = function () {
      p.set(100, 'Error de conexión. Revisa tu señal e inténtalo de nuevo.');
      if (submitBtn) submitBtn.disabled = false;
    };
    xhr.send(data);
  });
})();
</script>`;

function layout(title, body, meta = {}) {
  const fullTitle = meta.fullTitle || `${title} — aqui.online · Personas y terremoto en Colombia`;
  const description = meta.description || DEFAULT_DESCRIPTION;
  const url = meta.path ? `${env.BASE_URL}${meta.path}` : env.BASE_URL;
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:site_name" content="aqui.online">
<meta property="og:type" content="website">
<meta property="og:locale" content="es_CO">
<meta property="og:title" content="${esc(fullTitle)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(fullTitle)}">
<meta name="twitter:description" content="${esc(description)}">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<div class="tricolor"><span class="y"></span><span class="b"></span><span class="r"></span></div>
<header>
  <a class="brand" href="/">📍 aqui.online</a>
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
  <p><a href="/privacidad">Política de privacidad</a> · <a href="/terminos">Términos de servicio</a></p>
</footer>
${RESIZE_SCRIPT}
${TIME_SCRIPT}
</body>
</html>`;
}

function statusBadge(status) {
  return `<span class="badge ${STATUS_CLASS[status] || 'muted'}">${esc(
    STATUS_LABEL[status] || status
  )}</span>`;
}

// Timestamps are always shown in the VIEWER's timezone (done client-side —
// the server cannot know it). Without JavaScript we fall back to a relative
// time, which is correct in every timezone instead of guessing one.
function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return esc(iso || '');
  const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  if (mins < 1) return 'hace instantes';
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `hace ${hours} h`;
  return `hace ${Math.round(hours / 24)} días`;
}

// <time> element carrying the machine-readable instant so the client can
// localize it.
function timeTag(iso) {
  return `<time class="ts" datetime="${esc(iso || '')}">${fmtDate(iso)}</time>`;
}

// Render every timestamp in the viewer's own timezone and locale.
const TIME_SCRIPT = `<script>
(function () {
  var opts = { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' };
  var els = document.querySelectorAll('time.ts');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var iso = el.getAttribute('datetime');
    if (!iso) continue;
    var d = new Date(iso);
    if (isNaN(d.getTime())) continue;
    try {
      // undefined locale + no timeZone option = the viewer's own settings
      el.textContent = d.toLocaleString(undefined, opts);
      el.title = d.toLocaleString();
    } catch (e) {}
  }
})();
</script>`;

function mapLink(u) {
  if (u.lat == null || u.lng == null) return '';
  return ` · <a href="https://www.openstreetmap.org/?mlat=${u.lat}&amp;mlon=${u.lng}#map=16/${u.lat}/${u.lng}" target="_blank" rel="noopener">ver en mapa</a>`;
}

function updateCard(u, personName) {
  return `<article class="card">
  ${personName ? `<h3><a href="/person/${u.person_id}">${esc(personName)}</a></h3>` : ''}
  <p>${statusBadge(u.status)} ${timeTag(u.created_at)}</p>
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
      // GPS is more precise than a typed address: hide the address field.
      var field = document.getElementById('location-field');
      if (field) field.style.display = 'none';
      fetch('https://nominatim.openstreetmap.org/reverse?format=json&lat=' + pos.coords.latitude + '&lon=' + pos.coords.longitude)
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var loc = document.getElementById('location');
          if (d.display_name && !loc.value) loc.value = d.display_name.split(',').slice(0, 4).join(',');
          if (loc && loc.value) btn.textContent = '✅ ' + loc.value;
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

module.exports = { esc, layout, statusBadge, updateCard, fmtDate, timeTag, PRIVACY_NOTE, LOCATION_SCRIPT };
