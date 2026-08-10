const express = require('express');
const multer = require('multer');
const { notifySubscribers, sendVerificationEmail, STATUS_LABEL } = require('../notify');
const { STATUSES } = require('../people');
const { processPhoto, MAX_QUERY_PHOTOS } = require('../facematch');
const { esc, layout, statusBadge, updateCard, PRIVACY_NOTE, LOCATION_SCRIPT } = require('../html');

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
<div class="hero"><h1>¿Tu familia y amigos están bien?</h1></div>
<div class="big-actions">
  <a class="big-btn report" href="/report">📢 Reportar estado de alguien</a>
  <a class="big-btn search" href="/buscar">🔎 Buscar a alguien</a>
</div>
${
  recent.length
    ? '<h2>Últimos reportes</h2>' + recent.map((u) => updateCard(u, u.full_name)).join('')
    : ''
}
`
        )
      );
    })
  );

  // Search page
  router.get(
    '/buscar',
    wrap(async (req, res) => {
      const q = (req.query.q || '').trim();
      let resultsHtml = '';
      if (q) {
        const matches = await store.searchPeople(q, { limit: 10 });
        if (!matches.length) {
          resultsHtml = `
<div class="error">
  <p>No encontramos reportes sobre <strong>${esc(q)}</strong>.</p>
  <p><a href="/report?name=${encodeURIComponent(q)}">Crear un reporte</a> o suscríbete abajo para recibir un aviso cuando haya noticias.</p>
</div>
<h2>Recibir aviso cuando haya noticias</h2>
<form class="stack" method="post" action="/subscribe-by-name" enctype="multipart/form-data" data-resize-photos>
  <input type="hidden" name="name" value="${esc(q)}">
  <input type="email" name="email" required placeholder="Tu correo electrónico *" aria-label="Tu correo electrónico">
  <label class="file-label"><span>📷 Fotos de la persona (opcional, 2–3 ayudan al reconocimiento)</span>
    <input type="file" name="photos" accept="image/*" multiple></label>
  ${PRIVACY_NOTE}
  <button>🔔 Avisarme cuando haya noticias de ${esc(q)}</button>
</form>`;
        } else {
          const cards = await Promise.all(
            matches.map(async (p) => {
              const latest = await store.getLatestUpdate(p.id);
              return `<article class="card">
  <h3><a href="/person/${p.id}">${esc(p.full_name)}</a></h3>
  ${latest ? `<p>${statusBadge(latest.status)} <time>${esc(latest.created_at)}</time></p>` : '<p class="subtle">Sin reportes todavía.</p>'}
</article>`;
            })
          );
          resultsHtml = `<h2>Resultados para "${esc(q)}"</h2>` + cards.join('');
        }
      }
      res.send(
        layout(
          'Buscar',
          `
<h1>¿Buscas a alguien?</h1>
<form method="get" action="/buscar" class="search-row">
  <input type="search" name="q" value="${esc(q)}" placeholder="Nombre de la persona (ej. Juan Pérez)" required autofocus>
  <button>Buscar</button>
</form>
<p class="subtle">No importa si no recuerdas el nombre exacto: buscamos por similitud y pronunciación.</p>
${resultsHtml}
`
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
<form class="stack compact" method="post" action="/report" enctype="multipart/form-data" data-resize-photos>
  <input name="name" required value="${esc(req.query.name || '')}" placeholder="Nombre completo de la persona *" aria-label="Nombre completo de la persona">
  <select name="status" required aria-label="Estado">
    <option value="" disabled selected>Estado *</option>
    ${options}
  </select>
  <textarea name="message" rows="2" placeholder="Nota: qué sabes, cuándo, cómo (opcional)" aria-label="Nota"></textarea>
  <input name="location" id="location" list="location-options" autocomplete="off" placeholder="Ubicación — elige una sugerencia (opcional)" aria-label="Ubicación">
  <datalist id="location-options"></datalist>
  <button type="button" id="geo-btn" class="secondary">📍 Compartir mi ubicación actual</button>
  <input type="hidden" name="lat" id="lat"><input type="hidden" name="lng" id="lng">
  <label class="file-label"><span>📷 Foto (opcional, galería o cámara)</span>
    <input type="file" name="photo" accept="image/*"></label>
  <input name="reporter" placeholder="Tu nombre o teléfono (opcional)" aria-label="Tu nombre o teléfono">
  ${PRIVACY_NOTE}
  <button>Enviar reporte</button>
</form>
${LOCATION_SCRIPT}`
      )
    );
  });

  router.post(
    '/report',
    upload.single('photo'),
    wrap(async (req, res) => {
      const { name, status, message, location, reporter } = req.body;
      if (!name || !name.trim() || !STATUSES.includes(status)) {
        return res.status(400).send(layout('Error', '<p class="error">Faltan datos del reporte.</p>'));
      }
      const { person } = await store.findOrCreatePerson(name);
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
      res.redirect(`/person/${person.id}?reported=1`);
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
      res.send(
        layout(
          person.full_name,
          `
${req.query.reported ? '<p class="notice">✅ Reporte registrado. Gracias por ayudar.</p>' : ''}
${req.query.subscribed ? '<p class="notice">🔔 Listo: te avisaremos por correo cuando haya novedades.</p>' : ''}
${req.query.checkemail ? '<p class="notice">📬 Te enviamos un correo de confirmación. Abre el enlace para activar los avisos.</p>' : ''}
<h1>${esc(person.full_name)}</h1>
${lastLocated ? `<p class="notice">📍 Última ubicación reportada: <strong>${esc(lastLocated.location)}</strong> (${esc(lastLocated.created_at)})</p>` : ''}
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
<p><a href="/report?name=${encodeURIComponent(person.full_name)}">➕ Agregar un nuevo reporte sobre esta persona</a></p>`
        )
      );
    })
  );

  router.post(
    '/person/:id/subscribe',
    upload.array('photos', 8),
    wrap(async (req, res) => {
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
        return res.redirect(`/person/${person.id}?checkemail=1`);
      }
      res.redirect(`/person/${person.id}?subscribed=1`);
    })
  );

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
        return res.redirect(`/person/${person.id}?checkemail=1`);
      }
      res.redirect(`/person/${person.id}?subscribed=1`);
    })
  );

  // Email verification link
  router.get(
    '/verify',
    wrap(async (req, res) => {
      const sub = await store.verifySubscription(req.query.token);
      if (!sub) {
        return res.status(404).send(layout('Enlace inválido', '<p class="error">Este enlace de confirmación no es válido o ya fue usado.</p>'));
      }
      res.redirect(`/person/${sub.person_id}?subscribed=1`);
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
<p><strong>Aquí</strong> existe con un único propósito: ayudar a reportar y encontrar personas durante emergencias, como el terremoto en Colombia del lunes 10 de agosto. Tratamos tu información con ese único fin.</p>
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
<p><strong>Aquí</strong> es un servicio gratuito y de emergencia para reportar y encontrar personas. Al usarlo aceptas estos términos, que mantenemos deliberadamente simples dada la naturaleza de la emergencia:</p>
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

  return router;
}

module.exports = { webRoutes };
