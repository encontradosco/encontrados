const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { notifySubscribers, sendVerificationEmail, STATUS_LABEL } = require('../notify');
const { STATUSES } = require('../people');
const { processPhoto, MAX_QUERY_PHOTOS } = require('../facematch');
const { esc, layout, statusBadge, updateCard, timeTag, PRIVACY_NOTE, LOCATION_SCRIPT } = require('../html');

// Express 4 doesn't catch async errors on its own.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 8 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/'))
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function webRoutes(store, matcher) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: true }));

  async function attachQueryPhotos(person, sub, files) {
    if (!sub || !files || !files.length) return;
    let count = await store.countQueryPhotos(sub.id);
    for (const f of files) {
      if (count >= MAX_QUERY_PHOTOS) break;
      await processPhoto(store, matcher, {
        personId: person.id,
        kind: 'query',
        subscriptionId: sub.id,
        bytes: f.buffer,
        contentType: f.mimetype
      });
      count++;
    }
  }

  // Home: earthquake banner (in layout) + the two big actions + recent reports
  router.get(
    '/',
    wrap(async (req, res) => {
      if (req.query.q) return res.redirect(`/buscar?q=${encodeURIComponent(req.query.q)}`);
      const recent = await store.getRecentUpdates(5);
      res.send(
        layout(
          'Inicio',
          `
<div class="hero">
  <h1>¿Tu familia y amigos están bien?</h1>
  <p class="subhead">Información provista por voluntarios y extraída de bases de datos públicas.</p>
</div>
<div class="big-actions">
  <a class="big-btn report" href="/report">
    <span class="btn-title">📢 Reportar estado de alguien</span>
    <span class="btn-sub">Tuyo o de otra persona</span>
  </a>
  <a class="big-btn search" href="/buscar">
    <span class="btn-title">🔎 Buscar a alguien</span>
    <span class="btn-sub">Por nombre o reconocimiento facial</span>
  </a>
</div>
${
  recent.length
    ? '<h2>Últimos reportes</h2>' + recent.map((u) => updateCard(u, u.full_name)).join('')
    : ''
}
`,
          {
            fullTitle: 'aqui.online — Encuentro y reporto a personas por nombre o por reconocimiento facial',
            description:
              'Tras el terremoto en Colombia del 10 de agosto. Información provista por voluntarios y extraída de bases de datos públicas.',
            path: '/'
          }
        )
      );
    })
  );

  // Search page: name and/or photos, in one step
  function buscarForm(q) {
    return `
<form class="stack compact" method="post" action="/buscar" enctype="multipart/form-data" data-resize-photos data-require-name-or-photos>
  <input type="search" name="q" value="${esc(q)}" placeholder="Nombre de la persona (ej. Juan Pérez)" aria-label="Nombre">
  <label class="file-label"><span>📷 O sube 1–3 fotos de la persona para buscar por rostro</span>
    <input type="file" name="photos" accept="image/*" multiple></label>
  ${PRIVACY_NOTE}
  <input type="email" name="email" placeholder="Tu correo (opcional — te avisamos si hay noticias)" aria-label="Tu correo">
  <button>🔎 Buscar</button>
</form>
<p class="subtle">No importa si no recuerdas el nombre exacto: buscamos por similitud y pronunciación.</p>
<script>
document.addEventListener('submit', function (ev) {
  var f = ev.target;
  if (!f.matches('form[data-require-name-or-photos]')) return;
  var q = f.querySelector('input[name=q]').value.trim();
  var ph = f.querySelector('input[type=file]').files.length;
  if (!q && !ph) {
    ev.preventDefault();
    ev.stopImmediatePropagation();
    alert('Escribe un nombre o sube al menos una foto.');
  }
}, true);
</script>`;
  }

  function newSearchButton() {
    return '<p><a class="big-btn search" href="/buscar">🔎 Nueva búsqueda</a></p>';
  }

  async function nameResultsHtml(q) {
    const matches = await store.searchPeople(q, { limit: 10 });
    if (!matches.length) return null;
    const cards = await Promise.all(
      matches.map(async (p) => {
        const latest = await store.getLatestUpdate(p.id);
        return `<article class="card">
  <h3><a href="/person/${p.id}">${esc(p.full_name)}</a></h3>
  ${latest ? `<p>${statusBadge(latest.status)} ${timeTag(latest.created_at)}</p>` : '<p class="subtle">Sin reportes todavía.</p>'}
</article>`;
      })
    );
    return `<h2>Resultados para "${esc(q)}"</h2>` + cards.join('');
  }

  router.get(
    '/buscar',
    wrap(async (req, res) => {
      const q = (req.query.q || '').trim();
      const found = q ? await nameResultsHtml(q) : null;
      // With results, the form gives way to a "Nueva búsqueda" button.
      // With no results, the form stays so they can retry or leave their email.
      const body = found
        ? `<h1 class="compact">Resultados</h1>${found}${newSearchButton()}`
        : `<h1 class="compact">¿Buscas a alguien?</h1>${
            q
              ? `<div class="error"><p>No encontramos reportes sobre <strong>${esc(q)}</strong>. Deja tu correo abajo y te avisamos, o <a href="/report?name=${encodeURIComponent(q)}">crea un reporte</a>.</p></div>`
              : ''
          }${buscarForm(q)}`;
      res.send(
        layout('Buscar', body, {
          fullTitle: q
            ? `¿Has visto a ${q}? — aqui.online · Terremoto en Colombia`
            : 'Buscar a alguien — aqui.online · Terremoto en Colombia',
          description: q
            ? `Buscamos noticias sobre ${q} tras el terremoto en Colombia. Si sabes algo, repórtalo aquí; las familias reciben el aviso al instante.`
            : 'Busca por nombre (aunque no lo recuerdes exacto) o por foto con reconocimiento facial privado.',
          path: q ? `/buscar?q=${encodeURIComponent(q)}` : '/buscar'
        })
      );
    })
  );

  router.post(
    '/buscar',
    upload.array('photos', 8),
    wrap(async (req, res) => {
      const q = (req.body.q || '').trim();
      const email = (req.body.email || '').trim();
      const files = (req.files || []).slice(0, MAX_QUERY_PHOTOS);
      if (!q && !files.length) {
        return res.redirect(303, '/buscar');
      }

      const sections = [];

      // Immediate face search: compare uploaded photos against report photos.
      if (files.length) {
        const bestByPerson = new Map();
        for (const f of files) {
          try {
            const found = await matcher.searchByImage(f.buffer);
            const photos = await store.photosByFaceIds(found.map((m) => m.faceId));
            for (const p of photos.filter((ph) => ph.kind === 'report')) {
              const sim = found.find((m) => m.faceId === p.face_id)?.similarity || 0;
              if (!bestByPerson.has(p.person_id) || bestByPerson.get(p.person_id) < sim) {
                bestByPerson.set(p.person_id, sim);
              }
            }
          } catch (e) {
            console.error('[buscar face]', e);
          }
        }
        if (bestByPerson.size) {
          const cards = [];
          for (const [personId, sim] of [...bestByPerson.entries()].sort((a, b) => b[1] - a[1])) {
            const person = await store.getPerson(personId);
            if (!person) continue;
            const latest = await store.getLatestUpdate(personId);
            cards.push(`<article class="card">
  <h3><a href="/person/${person.id}">${esc(person.full_name)}</a></h3>
  <p>👤 Coincidencia facial: ${Math.round(sim)}%</p>
  ${latest ? `<p>${statusBadge(latest.status)} ${timeTag(latest.created_at)}</p>` : ''}
</article>`);
          }
          sections.push('<h2>Posibles coincidencias por rostro</h2>' + cards.join(''));
        } else if (matcher.enabled) {
          sections.push(
            `<div class="error"><p>🔍 Revisamos ${files.length === 1 ? 'tu foto' : `tus ${files.length} fotos`} contra todos los reportes con foto y <strong>no encontramos coincidencias todavía</strong>.</p><p>Deja tu correo abajo y te avisaremos apenas alguien reporte a esta persona.</p></div>`
          );
        } else {
          sections.push(
            '<div class="error"><p>El reconocimiento facial no está disponible en este momento. Guardamos tu búsqueda: deja tu correo abajo y te avisaremos.</p></div>'
          );
        }
      }

      if (q) {
        const nameHtml = await nameResultsHtml(q);
        if (nameHtml) sections.push(nameHtml);
        else sections.push(`<div class="error"><p>No encontramos reportes con el nombre <strong>${esc(q)}</strong>.</p></div>`);
      }

      // Subscribe for future alerts if they left an email.
      let notice = '';
      if (email && EMAIL_RE.test(email)) {
        const anchorName = q || `Búsqueda por foto ${crypto.randomBytes(3).toString('hex')}`;
        const { person } = await store.findOrCreatePerson(anchorName);
        const { sub, needsVerification } = await store.subscribe(person.id, 'email', email);
        await attachQueryPhotos(person, sub, files);
        if (needsVerification) {
          sendVerificationEmail(person, sub).catch((e) => console.error('[buscar verify]', e));
          return res.redirect(303, checkEmailUrl(q ? `/buscar?q=${encodeURIComponent(q)}` : '/buscar'));
        }
        notice = '<p class="notice">🔔 Te avisaremos cuando haya novedades.</p>';
      } else if (files.length) {
        await Promise.resolve(); // photos are not stored without an email — nothing to keep
        sections.push('<p class="subtle">Deja tu correo en el formulario para avisarte si aparece una coincidencia futura.</p>');
      }

      res.send(
        layout(
          'Buscar',
          `<h1 class="compact">Resultados${q ? ` para "${esc(q)}"` : ''}</h1>${notice}${sections.join('')}
<p><a href="/report${q ? `?name=${encodeURIComponent(q)}` : ''}">➕ ¿Tienes información? Crea un reporte</a></p>
${newSearchButton()}`,
          {
            fullTitle: q
              ? `¿Has visto a ${q}? — aqui.online · Terremoto en Colombia`
              : 'Resultados de búsqueda — aqui.online'
          }
        )
      );
    })
  );

  // Report form
  router.get('/report', (req, res) => {
    const options = STATUSES.map(
      (s) => `<option value="${s}">${esc(STATUS_LABEL[s])}</option>`
    ).join('');
    res.send(
      layout(
        'Reportar estado',
        `
<h1 class="compact">Reportar estado <span class="subtle">(de otra persona o tuyo)</span></h1>
<form class="stack compact" method="post" action="/report" enctype="multipart/form-data" data-resize-photos data-require-name-or-photo>
  <input name="name" value="${esc(req.query.name || '')}" placeholder="Nombre de la persona (si lo sabes)" aria-label="Nombre de la persona">
  <label class="file-label"><span>📷 Foto de la persona (galería o cámara — clave si no sabes su nombre)</span>
    <input type="file" name="photo" accept="image/*"></label>
  ${PRIVACY_NOTE}
  <select name="status" required aria-label="Estado">
    <option value="" disabled selected>Estado *</option>
    ${options}
  </select>
  <textarea name="message" rows="2" placeholder="Nota: qué sabes, cuándo, cómo (opcional)" aria-label="Nota"></textarea>
  <input name="location" id="location" list="location-options" autocomplete="off" placeholder="Ubicación — elige una sugerencia (opcional)" aria-label="Ubicación">
  <datalist id="location-options"></datalist>
  <button type="button" id="geo-btn" class="secondary">📍 Compartir mi ubicación actual</button>
  <input type="hidden" name="lat" id="lat"><input type="hidden" name="lng" id="lng">
  <input name="reporter" placeholder="Tu nombre o teléfono (opcional)" aria-label="Tu nombre o teléfono">
  <button>Enviar reporte</button>
</form>
<script>
document.addEventListener('submit', function (ev) {
  var f = ev.target;
  if (!f.matches('form[data-require-name-or-photo]')) return;
  var name = f.querySelector('input[name=name]').value.trim();
  var ph = f.querySelector('input[type=file]').files.length;
  if (!name && !ph) {
    ev.preventDefault();
    ev.stopImmediatePropagation();
    alert('Escribe el nombre de la persona o sube una foto (al menos uno de los dos).');
  }
}, true);
</script>
${LOCATION_SCRIPT}`,
        {
          fullTitle: 'Reportar el estado de una persona — aqui.online · Terremoto en Colombia',
          description:
            '¿Sabes cómo está alguien tras el terremoto en Colombia? Repórtalo en un minuto: las familias suscritas reciben el aviso de inmediato.',
          path: '/report'
        }
      )
    );
  });

  router.post(
    '/report',
    upload.single('photo'),
    wrap(async (req, res) => {
      const { name, status, message, location, reporter } = req.body;
      const hasName = name && name.trim();
      if (!STATUSES.includes(status) || (!hasName && !req.file)) {
        return res
          .status(400)
          .send(layout('Error', '<p class="error">Faltan datos: indica el estado y el nombre o una foto de la persona.</p>'));
      }
      // Unknown/unconscious person: anchor on a uniquely-named placeholder;
      // the photo becomes the identifier via face matching.
      const personName = hasName
        ? name
        : `Persona sin identificar ${crypto.randomBytes(2).toString('hex')}`;
      const { person } = await store.findOrCreatePerson(personName);
      const update = await store.addUpdate(person.id, {
        status,
        message,
        location,
        lat: parseFloat(req.body.lat),
        lng: parseFloat(req.body.lng),
        source: 'web',
        reporter
      });
      notifySubscribers(store, person, update).catch((e) => console.error('[web notify]', e));
      if (req.file) {
        await processPhoto(store, matcher, {
          personId: person.id,
          kind: 'report',
          updateId: update.id,
          bytes: req.file.buffer,
          contentType: req.file.mimetype
        });
      }
      res.redirect(303, `/person/${person.id}?reported=1`);
    })
  );

  // Person page: timeline + email subscription (with optional query photos)
  router.get(
    '/person/:id',
    wrap(async (req, res) => {
      const person = await store.getPerson(req.params.id);
      if (!person) {
        return res.status(404).send(layout('No encontrado', '<p class="error">Persona no encontrada.</p>'));
      }
      const updates = await store.getUpdates(person.id);
      const lastLocated = updates.find((u) => u.location);
      const personMeta = {
        fullTitle: `${person.full_name}: estado y noticias — aqui.online`,
        description: updates.length
          ? `Últimos reportes sobre ${person.full_name} tras el terremoto en Colombia. Suscríbete para recibir avisos de novedades o agrega lo que sepas.`
          : `Aún no hay reportes sobre ${person.full_name}. Si sabes algo, repórtalo; las familias reciben el aviso al instante.`,
        path: `/person/${person.id}`
      };
      res.send(
        layout(
          person.full_name,
          `
${req.query.reported ? '<p class="notice">✅ Reporte registrado. Gracias por ayudar.</p>' : ''}
${req.query.subscribed ? '<p class="notice">🔔 Listo: te avisaremos por correo cuando haya novedades.</p>' : ''}
${req.query.checkemail ? '<p class="notice">📬 Te enviamos un correo de confirmación. Abre el enlace para activar los avisos.</p>' : ''}
<h1>${esc(person.full_name)}</h1>
${lastLocated ? `<p class="notice">📍 Última ubicación reportada: <strong>${esc(lastLocated.location)}</strong> (${timeTag(lastLocated.created_at)})</p>` : ''}
${
  updates.length
    ? updates.map((u) => updateCard(u)).join('')
    : '<p class="subtle">Sin reportes todavía.</p>'
}
<h2>Recibir avisos por correo</h2>
<form class="stack compact" method="post" action="/person/${person.id}/subscribe" enctype="multipart/form-data" data-resize-photos>
  <input type="email" name="email" required placeholder="Tu correo electrónico *" aria-label="Tu correo electrónico">
  <label class="file-label"><span>📷 Fotos de la persona (opcional, 2–3 ayudan al reconocimiento)</span>
    <input type="file" name="photos" accept="image/*" multiple></label>
  ${PRIVACY_NOTE}
  <button>🔔 Suscribirme a novedades de ${esc(person.full_name)}</button>
</form>
<p><a href="/report?name=${encodeURIComponent(person.full_name)}">➕ Agregar un nuevo reporte sobre esta persona</a></p>`,
          personMeta
        )
      );
    })
  );

  function checkEmailUrl(next) {
    return `/revisa-tu-correo${next ? `?next=${encodeURIComponent(next)}` : ''}`;
  }

  const subscribeHandler = wrap(async (req, res) => {
    const person = await store.getPerson(req.params.id);
    if (!person) {
      return res.status(404).send(layout('No encontrado', '<p class="error">Persona no encontrada.</p>'));
    }
    const email = (req.body.email || '').trim();
    if (!EMAIL_RE.test(email)) {
      return res.status(400).send(layout('Error', '<p class="error">Correo inválido.</p>'));
    }
    const { sub, needsVerification } = await store.subscribe(person.id, 'email', email);
    await attachQueryPhotos(person, sub, req.files);
    if (needsVerification) {
      sendVerificationEmail(person, sub).catch((e) => console.error('[verify email]', e));
      return res.redirect(303, checkEmailUrl(`/person/${person.id}`));
    }
    res.redirect(303, `/person/${person.id}?subscribed=1`);
  });

  router.post('/person/:id/subscribe', upload.array('photos', 8), subscribeHandler);
  // Alias: some browsers/proxies have been seen posting to the person URL itself.
  router.post('/person/:id', upload.array('photos', 8), subscribeHandler);

  // Subscribe to a name with no reports yet (creates the person placeholder)
  router.post(
    '/subscribe-by-name',
    upload.array('photos', 8),
    wrap(async (req, res) => {
      const { name, email } = req.body;
      if (!name || !name.trim() || !EMAIL_RE.test((email || '').trim())) {
        return res.status(400).send(layout('Error', '<p class="error">Faltan datos.</p>'));
      }
      const { person } = await store.findOrCreatePerson(name);
      const { sub, needsVerification } = await store.subscribe(person.id, 'email', email.trim());
      await attachQueryPhotos(person, sub, req.files);
      if (needsVerification) {
        sendVerificationEmail(person, sub).catch((e) => console.error('[verify email]', e));
        return res.redirect(303, checkEmailUrl(`/person/${person.id}`));
      }
      res.redirect(303, `/person/${person.id}?subscribed=1`);
    })
  );

  // Full-screen "check your email" page
  router.all('/revisa-tu-correo', (req, res) => {
    const next = String(req.query.next || '/');
    const safeNext = next.startsWith('/') ? next : '/';
    res.send(
      layout(
        'Revisa tu correo',
        `
<div class="takeover">
  <div class="takeover-emoji">📬</div>
  <h1>Para continuar, sigue el enlace que te enviamos por correo.</h1>
  <p>Sin ese paso no podremos avisarte. Revisa tu bandeja de entrada — y la carpeta de spam — un correo de <strong>a@torrenegra.com</strong>.</p>
  <p class="subtle"><a href="${esc(safeNext)}">Volver</a></p>
</div>`,
        { fullTitle: 'Revisa tu correo — aqui.online' }
      )
    );
  });

  // Email verification link → full-screen confirmation
  router.all(
    '/verify',
    wrap(async (req, res) => {
      const sub = await store.verifySubscription(req.query.token);
      if (!sub) {
        return res.status(404).send(layout('Enlace inválido', '<p class="error">Este enlace de confirmación no es válido o ya fue usado.</p>'));
      }
      const person = await store.getPerson(sub.person_id);
      res.send(
        layout(
          'Suscripción confirmada',
          `
<div class="takeover">
  <div class="takeover-emoji">✅</div>
  <h1>Listo: te avisaremos por correo apenas encontremos coincidencias.</h1>
  ${person ? `<p><a class="big-btn search" href="/person/${person.id}">Ver los reportes de ${esc(person.full_name)}</a></p>` : ''}
  <p class="subtle"><a href="/">Ir al inicio</a></p>
</div>`,
          { fullTitle: 'Suscripción confirmada — aqui.online' }
        )
      );
    })
  );

  // One-click unsubscribe link (included in every alert)
  router.get(
    '/unsubscribe',
    wrap(async (req, res) => {
      const sub = await store.unsubscribeByToken(req.query.token);
      if (!sub) {
        return res.status(404).send(layout('Enlace inválido', '<p class="error">Este enlace ya no es válido: la suscripción no existe.</p>'));
      }
      const person = await store.getPerson(sub.person_id);
      res.send(
        layout(
          'Suscripción cancelada',
          `<p class="notice">✅ Listo: ya no recibirás avisos sobre <strong>${esc(person ? person.full_name : '')}</strong>.</p>
<p><a href="/person/${sub.person_id}">Volver a la página de la persona</a></p>`
        )
      );
    })
  );

  // Privacy policy — light, emergency-focused
  router.get('/privacidad', (req, res) => {
    res.send(
      layout(
        'Política de privacidad',
        `
<h1>Política de privacidad</h1>
<p class="subtle">Última actualización: 10 de agosto de 2026</p>
<p><strong>aqui.online</strong> existe con un único propósito: ayudar a reportar y encontrar personas durante emergencias, como el terremoto en Colombia del lunes 10 de agosto. Tratamos tu información con ese único fin.</p>
<h2>Qué guardamos</h2>
<ul>
  <li><strong>Reportes:</strong> nombre de la persona, estado, nota, ubicación y (opcional) quién reporta.</li>
  <li><strong>Suscripciones:</strong> tu correo o número de teléfono, solo para enviarte avisos que pediste.</li>
  <li><strong>Fotos:</strong> si subes fotos, se guardan de forma privada.</li>
</ul>
<h2>Las fotos nunca se comparten</h2>
<p>Las fotos <strong>jamás</strong> se muestran a otros usuarios, no se publican y no se comparten con nadie. Se usan <strong>exclusivamente</strong> para reconocimiento facial: si una foto de un reporte coincide con las fotos de una búsqueda, la persona interesada recibe un aviso de posible coincidencia, <strong>sin ver ninguna foto</strong>. No existe en este sitio ninguna página que muestre fotos.</p>
<h2>Qué no hacemos</h2>
<ul>
  <li>No vendemos ni compartimos tus datos con terceros con fines comerciales.</li>
  <li>No usamos tu información para publicidad.</li>
  <li>No usamos las fotos para nada distinto a la comparación facial descrita.</li>
</ul>
<h2>Baja y eliminación</h2>
<p>Cada aviso incluye un enlace para darte de baja con un clic. Si quieres que eliminemos un reporte o tus fotos, escribe a <a href="mailto:a@torrenegra.com">a@torrenegra.com</a>.</p>
<p>Los reportes de estado (sin fotos) son visibles públicamente porque ese es el propósito del servicio: que las familias encuentren información.</p>`
      )
    );
  });

  // Terms of service — very light
  router.get('/terminos', (req, res) => {
    res.send(
      layout(
        'Términos de servicio',
        `
<h1>Términos de servicio</h1>
<p class="subtle">Última actualización: 10 de agosto de 2026</p>
<p><strong>aqui.online</strong> es un servicio gratuito y de emergencia para reportar y encontrar personas. Al usarlo aceptas estos términos, que mantenemos deliberadamente simples dada la naturaleza de la emergencia:</p>
<ul>
  <li><strong>Usa el servicio de buena fe.</strong> Publica solo información que creas cierta y que ayude a encontrar o informar sobre personas. Está prohibido publicar información falsa, ofensiva o con intención de dañar.</li>
  <li><strong>Es un esfuerzo voluntario y de mejor esfuerzo.</strong> La información proviene de la comunidad y puede ser incorrecta o estar desactualizada. Verifica siempre por otros medios antes de tomar decisiones críticas.</li>
  <li><strong>Sin garantías.</strong> El servicio se ofrece "tal cual", sin garantía de disponibilidad ni exactitud, y no sustituye a las autoridades ni a los organismos de socorro.</li>
  <li><strong>Privacidad primero.</strong> Tu información se usa únicamente para ayudar a las personas a encontrar a sus seres queridos, como describe la <a href="/privacidad">política de privacidad</a>. Las fotos nunca se comparten ni se muestran.</li>
  <li><strong>Podemos retirar contenido</strong> que incumpla estos términos, y responder a solicitudes legítimas de eliminación en <a href="mailto:a@torrenegra.com">a@torrenegra.com</a>.</li>
</ul>`
      )
    );
  });

  // API documentation
  router.get(['/api-doc', '/api-docs'], (req, res) => {
    res.send(
      layout(
        'API',
        `
<h1>API de aqui.online</h1>
<p>Base: <code>https://aqui.online/api</code> · JSON (<code>Content-Type: application/json</code>). Lecturas públicas.</p>

<h2>1. Reportar el estado de una persona</h2>
<p><code>POST /api/updates</code> — crea la persona si no existe; si el nombre coincide con alguien ya reportado (typos, acentos o apellidos faltantes incluidos), el reporte se une a esa persona.</p>
<pre>curl -X POST https://aqui.online/api/updates \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Juan Carlos Pérez",
    "status": "safe",
    "message": "Confirmado por teléfono a las 3pm",
    "location": "Albergue San José, Mocoa",
    "lat": 1.1522, "lng": -76.6527,
    "reporter": "María Gómez, Cruz Roja",
    "photo": { "base64": "&lt;JPEG en base64&gt;", "content_type": "image/jpeg" }
  }'</pre>
<ul>
  <li><code>name</code> y <code>status</code> son obligatorios; el resto opcional.</li>
  <li><code>status</code>: <code>safe</code> (a salvo) · <code>injured</code> (herido) · <code>missing</code> (desaparecido) · <code>deceased</code> (fallecido) · <code>unknown</code> (sin confirmar).</li>
  <li><code>photo</code>: opcional, máx. 4 MB. La foto <strong>nunca se muestra a nadie</strong>: solo reconocimiento facial.</li>
  <li>Respuesta 201: <code>{ "person_id": 12, "person_created": true, "update": {…}, "photo_stored": true }</code>. Los suscriptores verificados reciben el aviso automáticamente.</li>
</ul>

<h2>2. Buscar personas</h2>
<pre>curl 'https://aqui.online/api/people?q=jaun%20peres'</pre>
<p>Tolera typos, acentos y nombres incompletos. Devuelve <code>results</code> ordenados por similitud con su <code>latest_update</code>.</p>

<h2>3. Historial de una persona</h2>
<pre>curl https://aqui.online/api/people/12</pre>

<h2>4. Suscribirse a novedades</h2>
<pre>curl -X POST https://aqui.online/api/people/12/subscriptions \
  -H 'Content-Type: application/json' \
  -d '{
    "channel": "email",
    "address": "familia@ejemplo.com",
    "photos": [{ "base64": "&lt;JPEG base64&gt;", "content_type": "image/jpeg" }]
  }'</pre>
<ul>
  <li><code>channel</code>: <code>email</code> (activo). Las suscripciones por correo requieren verificación por enlace; ninguna alerta se envía antes (<code>pending_verification: true</code>).</li>
  <li><code>photos</code> (máx. 3): fotos de la persona buscada, solo para reconocimiento facial. Si un reporte futuro coincide, el suscriptor recibe el aviso <strong>sin ver ninguna foto</strong>.</li>
  <li>Todo aviso incluye enlace de baja de un clic.</li>
</ul>

<p class="subtle">Publica solo información que creas cierta — ver <a href="/terminos">términos</a> y <a href="/privacidad">privacidad</a>.</p>`
      )
    );
  });

  return router;
}

module.exports = { webRoutes };
