const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { sendVerificationEmail } = require('../notify');
const { processPhoto, identifyRescuedPerson, MAX_QUERY_PHOTOS } = require('../facematch');
const { esc, layout, updateCard, timeTag, LOCATION_SCRIPT } = require('../html');

// Express 4 doesn't catch async errors on its own.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 8 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/'))
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REPORTER_COOKIE = 'aqui_reporter';
const EMAIL_COOKIE = 'aqui_email';

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  const hit = raw.split(';').map((c) => c.trim()).find((c) => c.startsWith(name + '='));
  if (!hit) return '';
  try {
    return decodeURIComponent(hit.slice(name.length + 1)).slice(0, 120);
  } catch {
    return '';
  }
}

// Remember who is reporting so a volunteer filing many reports types it once.
function remember(res, name, value) {
  const v = (value || '').trim();
  if (!v) return;
  res.append(
    'Set-Cookie',
    `${name}=${encodeURIComponent(v.slice(0, 120))}; Path=/; Max-Age=2592000; SameSite=Lax`
  );
}

const RESCUE_PRIVACY = `<p class="privacy">🔒 <strong>Tu foto no se guarda.</strong> Se compara al instante contra las fotos de las personas reportadas como desaparecidas y se borra de inmediato: no queda almacenada en ningún servidor. Solo conservamos su <em>firma facial</em> (un código que no permite reconstruir la imagen) para poder avisarte si alguien empieza a buscar a esta persona.</p>`;

const REPORT_PRIVACY = `<p class="privacy">🔒 Las fotos <strong>nunca</strong> se muestran públicamente ni se comparten: solo se usan para que un rescatista pueda reconocer a la persona por su rostro.</p>`;

function webRoutes(store, matcher) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: true }));

  // ---------------------------------------------------------------- home
  router.get(
    '/',
    wrap(async (req, res) => {
      const missing = await store.getMissingPeople(50);
      const list = missing.length
        ? `<h2>Personas reportadas como desaparecidas (${missing.length})</h2>` +
          missing
            .map(
              (p) => `<article class="card">
  <h3><a href="/person/${p.id}">${esc(p.full_name)}</a></h3>
  <p class="meta">Último reporte: ${timeTag(p.last_report)}</p>
</article>`
            )
            .join('')
        : '<p class="subtle">Todavía no hay personas reportadas como desaparecidas.</p>';

      res.send(
        layout(
          'Inicio',
          `
<div class="hero">
  <h1>Voluntarios, rescatistas, bomberos, policías y hospitales: mira quién está buscando la persona que rescataste</h1>
</div>
<div class="big-actions">
  <a class="big-btn report" href="/rescate">
    <span class="btn-eyebrow">🚑 🚒 👮 🏥 Tienes a la persona contigo</span>
    <span class="btn-title">📸 Mira quién la está buscando</span>
    <span class="btn-sub">Subes una foto, la comparamos y la borramos al instante</span>
  </a>
  <a class="big-btn search" href="/report">
    <span class="btn-title">📢 Reportar desaparecido</span>
  </a>
</div>
${list}
`,
          {
            fullTitle:
              'Voluntarios, rescatistas, bomberos, policías y hospitales: mira quién está buscando la persona que rescataste — aqui.online',
            description:
              'Si rescataste a alguien, sube su foto y te decimos quién la está buscando. La foto se borra de inmediato. También puedes reportar a una persona desaparecida.',
            path: '/'
          }
        )
      );
    })
  );

  // ------------------------------------------------------------- rescuer
  function rescueForm(rememberedEmail = '') {
    return `
<form class="stack compact" method="post" action="/rescate" enctype="multipart/form-data" data-resize-photos data-require-photo>
  <label class="file-label"><span>📷 Foto de la persona que tienes contigo *</span>
    <input type="file" name="photo" accept="image/*" required></label>
  ${RESCUE_PRIVACY}
  <input type="email" name="email" value="${esc(rememberedEmail)}" placeholder="Tu correo (opcional — te avisamos si alguien la busca después)" aria-label="Tu correo">
  <button>🔎 Ver quién la está buscando</button>
</form>
<script>
document.addEventListener('submit', function (ev) {
  var f = ev.target;
  if (!f.matches('form[data-require-photo]')) return;
  if (!f.querySelector('input[type=file]').files.length) {
    ev.preventDefault();
    ev.stopImmediatePropagation();
    alert('Sube una foto de la persona.');
  }
}, true);
</script>`;
  }

  router.get('/rescate', (req, res) => {
    res.send(
      layout(
        'Mira quién la está buscando',
        `
<h1 class="compact">¿Rescataste a alguien? Mira quién la está buscando</h1>
<p class="subtle">Sube una foto de la persona que tienes contigo. La comparamos con las fotos de las personas reportadas como desaparecidas y te mostramos los datos de contacto de quien la busca.</p>
${rescueForm(readCookie(req, EMAIL_COOKIE))}`,
        {
          fullTitle: 'Mira quién está buscando a la persona que rescataste — aqui.online',
          description:
            'Sube la foto de la persona que rescataste: te decimos quién la está buscando y cómo contactarlo. La foto se borra de inmediato.',
          path: '/rescate'
        }
      )
    );
  });

  router.post(
    '/rescate',
    upload.single('photo'),
    wrap(async (req, res) => {
      const email = (req.body.email || '').trim();
      if (!req.file) {
        return res.status(400).send(
          layout(
            'Mira quién la está buscando',
            `<h1 class="compact">¿Rescataste a alguien?</h1>
<div class="error"><p>Sube una foto de la persona: es lo que permite reconocerla.</p></div>
${rescueForm(email)}`
          )
        );
      }

      // An anchor person for this rescue, so an email alert can be attached.
      const { person } = await store.findOrCreatePerson(
        `Persona rescatada ${crypto.randomBytes(3).toString('hex')}`
      );
      let sub = null;
      let pendingVerification = false;
      if (EMAIL_RE.test(email)) {
        const result = await store.subscribe(person.id, 'email', email);
        sub = result.sub;
        pendingVerification = result.needsVerification;
        remember(res, EMAIL_COOKIE, email);
      }

      const { available, matches, photoId } = await identifyRescuedPerson(store, matcher, {
        bytes: req.file.buffer,
        contentType: req.file.mimetype,
        personId: person.id,
        subscriptionId: sub ? sub.id : null
      });

      if (sub && pendingVerification) {
        await sendVerificationEmail(person, sub);
      }

      let body;
      if (!available) {
        body = `<div class="error"><p>El reconocimiento facial no está disponible en este momento. Inténtalo de nuevo en unos minutos.</p></div>`;
      } else if (!matches.length) {
        body = `<div class="error">
  <p><strong>Nadie ha reportado a esta persona como desaparecida todavía.</strong></p>
  ${
    sub
      ? '<p>Te avisaremos por correo apenas alguien la busque (confirma tu correo con el enlace que te enviamos).</p>'
      : `<p>Déjanos tu correo y te avisamos apenas alguien la busque — no hace falta que vuelvas a subir la foto.</p>
  <form class="stack compact" method="post" action="/rescate/${person.id}/subscribe">
    <input type="hidden" name="photoId" value="${esc(photoId)}">
    <input type="email" name="email" required placeholder="Tu correo" aria-label="Tu correo">
    <button>🔔 Avísame cuando alguien la busque</button>
  </form>`
  }
</div>`;
      } else {
        body =
          `<h2>${matches.length === 1 ? 'La están buscando' : 'Coincidencias encontradas'}</h2>` +
          matches
            .map(
              (m) => `<article class="card">
  <h3><a href="/person/${m.person.id}">${esc(m.person.full_name)}</a></h3>
  <p>👤 Coincidencia facial: <strong>${Math.round(m.similarity)}%</strong></p>
  ${m.update && m.update.contact ? `<p>📞 <strong>Contacta a quien la busca:</strong> ${esc(m.update.contact)}</p>` : '<p class="subtle">Sin datos de contacto en el reporte.</p>'}
  ${m.update && m.update.location ? `<p class="loc">📍 Visto por última vez: ${esc(m.update.location)}</p>` : ''}
</article>`
            )
            .join('') +
          '<p class="subtle">Verifica siempre la identidad antes de entregar información sensible.</p>';
      }

      res.send(
        layout(
          'Resultado',
          `<h1 class="compact">Resultado</h1>
${body}
<p class="notice">🔒 La foto que subiste ya fue borrada. No quedó almacenada en ningún servidor.</p>
<p><a class="big-btn report" href="/rescate">📸 Consultar otra persona</a></p>`
        )
      );
    })
  );

  // The rescuer's face was already indexed by the /rescate POST above, even
  // when no match was found and no email was given. This lets them add an
  // email afterward WITHOUT re-uploading the photo or re-running the facial
  // match — purely additive: it never touches identifyRescuedPerson or the
  // matching pipeline in facematch.js, only links the existing photo row to
  // the new subscription so a later match still finds it.
  router.post(
    '/rescate/:personId/subscribe',
    wrap(async (req, res) => {
      const person = await store.getPerson(req.params.personId);
      if (!person) {
        return res.status(404).send(layout('No encontrado', '<p class="error">Persona no encontrada.</p>'));
      }
      const email = (req.body.email || '').trim();
      if (!EMAIL_RE.test(email)) {
        return res.status(400).send(
          layout(
            'Avísame cuando la busquen',
            `<h1 class="compact">Ese correo no parece válido</h1>
<p class="error">Revisa el correo e inténtalo de nuevo.</p>
<p><a href="/rescate">Volver</a></p>`
          )
        );
      }

      const { sub, needsVerification } = await store.subscribe(person.id, 'email', email);
      const photoId = req.body.photoId;
      if (photoId) {
        await store.setPhotoSubscriptionId(photoId, sub.id);
      }
      if (needsVerification) {
        await sendVerificationEmail(person, sub);
      }
      remember(res, EMAIL_COOKIE, email);

      res.send(
        layout(
          'Aviso registrado',
          `<div class="takeover">
  <div class="takeover-emoji">📬</div>
  <h1>Listo: confirma tu correo para activar el aviso.</h1>
  <p>Te escribimos a <strong>${esc(email)}</strong> con un enlace de confirmación. Sin ese paso no podremos avisarte.</p>
  <p class="subtle"><a href="/">Ir al inicio</a></p>
</div>`
        )
      );
    })
  );

  // ------------------------------------------------- report a missing person
  router.get('/report', (req, res) => {
    res.send(
      layout(
        'Reportar desaparecido',
        `
<h1 class="compact">Reportar una persona desaparecida</h1>
<p class="subtle">Cuando un rescatista tenga a esta persona, verá tus datos de contacto para avisarte.</p>
<form class="stack compact" method="post" action="/report" enctype="multipart/form-data" data-resize-photos data-require-photos>
  <label class="file-label"><span>📷 Fotos de la persona * (1 a 3 — así la reconocen los rescatistas)</span>
    <input type="file" name="photos" accept="image/*" multiple required></label>
  ${REPORT_PRIVACY}
  <input name="name" required value="${esc(req.query.name || '')}" placeholder="Nombre completo de la persona *" aria-label="Nombre completo">
  <span id="location-field">
    <input name="location" id="location" list="location-options" autocomplete="off" placeholder="Dónde crees que estaba *" aria-label="Ubicación" required>
    <datalist id="location-options"></datalist>
  </span>
  <button type="button" id="geo-btn" class="secondary">📍 Compartir mi ubicación actual</button>
  <input type="hidden" name="lat" id="lat"><input type="hidden" name="lng" id="lng">
  <input name="contact" required value="${esc(readCookie(req, REPORTER_COOKIE))}" placeholder="Tu teléfono o correo para que te contacten *" aria-label="Teléfono o correo de contacto">
  <textarea name="message" rows="2" placeholder="Otros datos que ayuden a reconocerla (opcional)" aria-label="Datos adicionales"></textarea>
  <button>Reportar desaparecido</button>
</form>
<script>
document.addEventListener('submit', function (ev) {
  var f = ev.target;
  if (!f.matches('form[data-require-photos]')) return;
  if (!f.querySelector('input[type=file]').files.length) {
    ev.preventDefault();
    ev.stopImmediatePropagation();
    alert('Sube al menos una foto de la persona.');
  }
}, true);
</script>
${LOCATION_SCRIPT}`,
        {
          fullTitle: 'Reportar una persona desaparecida — aqui.online',
          description:
            'Reporta a una persona desaparecida con sus fotos, el lugar donde crees que estaba y tu contacto. Los rescatistas podrán reconocerla y avisarte.',
          path: '/report'
        }
      )
    );
  });

  router.post(
    '/report',
    upload.array('photos', 8),
    wrap(async (req, res) => {
      const { name, location, contact, message } = req.body;
      const files = (req.files || []).slice(0, MAX_QUERY_PHOTOS);
      if (!name || !name.trim() || !location || !location.trim() || !contact || !contact.trim() || !files.length) {
        return res
          .status(400)
          .send(
            layout(
              'Error',
              '<p class="error">Faltan datos: hacen falta las fotos, el nombre, el lugar y un teléfono o correo de contacto.</p>'
            )
          );
      }

      const { person } = await store.findOrCreatePerson(name);
      const update = await store.addUpdate(person.id, {
        status: 'missing',
        message,
        location,
        lat: parseFloat(req.body.lat),
        lng: parseFloat(req.body.lng),
        source: 'web',
        contact
      });
      remember(res, REPORTER_COOKIE, contact);

      // Each photo is indexed so a rescuer holding this person can find the
      // report; a match also alerts any rescuer already waiting for news.
      for (const f of files) {
        await processPhoto(store, matcher, {
          personId: person.id,
          kind: 'report',
          updateId: update.id,
          bytes: f.buffer,
          contentType: f.mimetype
        });
      }

      res.redirect(303, `/person/${person.id}?reported=1`);
    })
  );

  // --------------------------------------------------------- person page
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
${req.query.reported ? '<p class="notice">✅ Reporte registrado. Cuando un rescatista tenga a esta persona, verá tus datos de contacto.</p>' : ''}
<h1>${esc(person.full_name)}</h1>
${lastLocated ? `<p class="notice">📍 Última ubicación reportada: <strong>${esc(lastLocated.location)}</strong> (${timeTag(lastLocated.created_at)})</p>` : ''}
${updates.length ? updates.map((u) => updateCard(u)).join('') : '<p class="subtle">Sin reportes todavía.</p>'}
<p class="subtle">Los datos de contacto de quien reporta solo se muestran a un rescatista cuando el rostro coincide.</p>
<p><a class="big-btn report" href="/rescate">📸 ¿La tienes contigo? Mira quién la busca</a></p>`,
          {
            fullTitle: `${person.full_name} — reportada como desaparecida · aqui.online`,
            description: `${person.full_name} fue reportada como desaparecida tras el terremoto en Colombia. Si la rescataste, aqui.online te dice quién la está buscando.`,
            path: `/person/${person.id}`
          }
        )
      );
    })
  );

  // ------------------------------------------- rescuer alert confirmation
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
  <p>Sin ese paso no podremos avisarte. Revisa tu bandeja de entrada —y la carpeta de spam— un correo de <strong>a@torrenegra.com</strong>.</p>
  <p class="subtle"><a href="${esc(safeNext)}">Volver</a></p>
</div>`,
        { fullTitle: 'Revisa tu correo — aqui.online' }
      )
    );
  });

  router.all(
    '/verify',
    wrap(async (req, res) => {
      const sub = await store.verifySubscription(req.query.token);
      if (!sub) {
        return res
          .status(404)
          .send(layout('Enlace inválido', '<p class="error">Este enlace de confirmación no es válido o ya fue usado.</p>'));
      }
      res.send(
        layout(
          'Aviso confirmado',
          `
<div class="takeover">
  <div class="takeover-emoji">✅</div>
  <h1>Listo: te avisaremos por correo apenas alguien busque a esta persona.</h1>
  <p class="subtle"><a href="/">Ir al inicio</a></p>
</div>`,
          { fullTitle: 'Aviso confirmado — aqui.online' }
        )
      );
    })
  );

  router.all(
    '/unsubscribe',
    wrap(async (req, res) => {
      const sub = await store.unsubscribeByToken(req.query.token);
      if (!sub) {
        return res
          .status(404)
          .send(layout('Enlace inválido', '<p class="error">Este enlace ya no es válido: el aviso no existe.</p>'));
      }
      res.send(
        layout(
          'Aviso cancelado',
          `<p class="notice">✅ Listo: ya no recibirás avisos.</p><p><a href="/">Ir al inicio</a></p>`
        )
      );
    })
  );

  // --------------------------------------------------------------- legal
  router.get('/privacidad', (req, res) => {
    res.send(
      layout(
        'Política de privacidad',
        `
<h1>Política de privacidad</h1>
<p class="subtle">Última actualización: 10 de agosto de 2026</p>
<p><strong>aqui.online</strong> existe con un único propósito: que un rescatista que tiene a una persona a su lado pueda encontrar a quien la está buscando, tras el terremoto en Colombia del lunes 10 de agosto.</p>

<h2>La foto del rescatista no se guarda</h2>
<p>Cuando un rescatista sube la foto de la persona que tiene consigo, esa imagen se compara al instante y <strong>se borra de inmediato</strong>. No queda almacenada en ningún servidor. Solo conservamos su <em>firma facial</em>: un código matemático que permite comparar rostros pero <strong>no permite reconstruir la fotografía</strong>. La conservamos para poder avisarle si más adelante alguien reporta a esa persona como desaparecida.</p>

<h2>Las fotos de los reportes</h2>
<p>Las fotos que acompañan un reporte de persona desaparecida se guardan de forma privada y se usan <strong>exclusivamente</strong> para el reconocimiento facial. <strong>Nunca</strong> se publican, se muestran ni se comparten con nadie: no existe en este sitio ninguna página que muestre fotos.</p>

<h2>Datos de contacto</h2>
<p>El teléfono o correo de quien reporta se muestra <strong>solo</strong> a un rescatista cuando el rostro de la persona que tiene consigo coincide con el reporte. No aparece en las páginas públicas ni se comparte de ninguna otra forma.</p>

<h2>Qué es público</h2>
<p>El nombre de la persona reportada, su estado y el lugar donde se le vio por última vez son visibles públicamente: ese es el propósito del servicio.</p>

<h2>Avisos y baja</h2>
<p>Solo los rescatistas pueden registrar un aviso por correo, y requiere confirmar el correo. Cada aviso incluye un enlace para darse de baja con un clic. Para eliminar un reporte o sus fotos, escribe a <a href="mailto:a@torrenegra.com">a@torrenegra.com</a>.</p>

<h2>Qué no hacemos</h2>
<ul>
  <li>No vendemos ni compartimos datos con terceros con fines comerciales.</li>
  <li>No usamos la información para publicidad.</li>
  <li>No usamos las fotos para nada distinto a la comparación de rostros descrita aquí.</li>
</ul>`,
        { fullTitle: 'Política de privacidad — aqui.online', path: '/privacidad' }
      )
    );
  });

  router.get('/terminos', (req, res) => {
    res.send(
      layout(
        'Términos de servicio',
        `
<h1>Términos de servicio</h1>
<p class="subtle">Última actualización: 10 de agosto de 2026</p>
<p><strong>aqui.online</strong> es un servicio gratuito y de emergencia que conecta a quien rescata a una persona con quien la está buscando. Al usarlo aceptas estos términos, deliberadamente simples dada la naturaleza de la emergencia:</p>
<ul>
  <li><strong>Úsalo de buena fe.</strong> Reporta solo información que creas cierta. Está prohibido publicar datos falsos o usar el servicio para localizar a alguien que no quiere ser encontrado.</li>
  <li><strong>Los datos de contacto son para reunir familias.</strong> Al mostrarse tras una coincidencia facial, deben usarse únicamente para informar sobre la persona; cualquier otro uso está prohibido.</li>
  <li><strong>Verifica antes de actuar.</strong> El reconocimiento facial es una ayuda, no una prueba: una coincidencia puede ser errónea. Confirma siempre la identidad por otros medios.</li>
  <li><strong>Sin garantías.</strong> El servicio se ofrece "tal cual", sin garantía de disponibilidad ni exactitud, y no sustituye a las autoridades ni a los organismos de socorro.</li>
  <li><strong>Podemos retirar contenido</strong> que incumpla estos términos y atender solicitudes de eliminación en <a href="mailto:a@torrenegra.com">a@torrenegra.com</a>.</li>
</ul>`,
        { fullTitle: 'Términos de servicio — aqui.online', path: '/terminos' }
      )
    );
  });

  // ------------------------------------------------------------ api docs
  router.get(['/api-doc', '/api-docs'], (req, res) => {
    res.send(
      layout(
        'API',
        `
<h1>API de aqui.online</h1>
<p>Base: <code>https://aqui.online/api</code> · JSON. Pensada para organismos de socorro que quieran reportar en lote.</p>

<h2>Reportar una persona desaparecida</h2>
<pre>curl -X POST https://aqui.online/api/updates \\
  -H 'Content-Type: application/json' \\
  -d '{
    "name": "Juan Carlos Pérez",
    "status": "missing",
    "location": "Barrio San José",
    "contact": "300 123 4567",
    "photo": { "base64": "&lt;JPEG en base64&gt;", "content_type": "image/jpeg" }
  }'</pre>
<ul>
  <li><code>name</code> y <code>status</code> son obligatorios. Para desaparecidos usa <code>missing</code>.</li>
  <li><code>contact</code>: teléfono o correo de quien debe ser avisado. Solo se muestra a un rescatista cuando hay coincidencia facial.</li>
  <li><code>photo</code>: opcional pero decisiva — es lo que permite el reconocimiento facial.</li>
</ul>

<h2>Consultar</h2>
<pre>curl 'https://aqui.online/api/people?q=jaun%20peres'
curl https://aqui.online/api/people/12</pre>

<p class="subtle">Publica solo información que creas cierta — ver <a href="/terminos">términos</a> y <a href="/privacidad">privacidad</a>.</p>`,
        { fullTitle: 'API — aqui.online', path: '/api-doc' }
      )
    );
  });

  return router;
}

module.exports = { webRoutes };
