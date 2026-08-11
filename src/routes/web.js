const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { sendVerificationEmail } = require('../notify');
const {
  processPhoto,
  identifyRescuedPerson,
  backfillPhotoDerivatives,
  MAX_QUERY_PHOTOS
} = require('../facematch');
const { esc, layout, updateCard, timeTag, facePlate, LOCATION_SCRIPT } = require('../html');
const { findDuplicateCandidates } = require('../duplicates');

// Express 4 doesn't catch async errors on its own.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 8 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/'))
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REPORTER_COOKIE = 'encontrados_reporter';
const EMAIL_COOKIE = 'encontrados_email';
// Renamed with the brand. Anyone who used the site before still has the old
// cookie, so read it as a fallback rather than making them type it again.
const LEGACY_COOKIE = { encontrados_reporter: 'aqui_reporter', encontrados_email: 'aqui_email' };

function readCookie(req, name, maxLength = 120) {
  const raw = req.headers.cookie || '';
  const read = (key) => {
    const hit = raw.split(';').map((c) => c.trim()).find((c) => c.startsWith(key + '='));
    if (!hit) return '';
    try {
      return decodeURIComponent(hit.slice(key.length + 1)).slice(0, maxLength);
    } catch {
      return '';
    }
  };
  return read(name) || read(LEGACY_COOKIE[name] || name);
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

const RESCUE_PRIVACY = `<p class="privacy">🔒 <strong>La foto no se guarda.</strong> Se compara al instante contra las fotos de las personas reportadas como desaparecidas y se borra de inmediato: no queda almacenada en ningún servidor. Solo conservamos su <em>firma facial</em> (un código que no permite reconstruir la imagen) para poder avisarte si alguien empieza a buscar a esta persona.</p>`;

// Where this list comes from — one small line under the listing heading, not a
// section of its own competing with it. Kept honest: only the first two
// actually feed the list today, so nothing here implies data is already
// flowing from a source that isn't wired up yet.
const SOURCES_NOTE = `<p class="subtle sources-note">Fuentes de información de desaparecidos: Encontrados.co, Colombia Te Busca. Próximamente: El Espectador, El Tiempo, El País, Semana, Cambio, Medicina Legal, UNGRD, Defensa Civil</p>`;

// The possible-duplicate finding travels from POST /report to the person page
// in a short-lived cookie rather than in the URL, and this is the whole reason
// why: the warning asserts that two specific missing people may be the same
// human. That claim belongs to the server, for the visitor who just reported —
// a query string would make it a link anyone could forge and circulate, and on
// a post-disaster site a forwarded "these two are the same person" is how a
// real report gets written off as a duplicate and stops being searched for.
// A cookie is not shareable; the worst a visitor can do is mislead themselves.
const DUP_COOKIE = 'encontrados_dup';
const DUP_TTL_SECONDS = 300;

function rememberDuplicateFinding(res, finding) {
  res.append(
    'Set-Cookie',
    `${DUP_COOKIE}=${encodeURIComponent(JSON.stringify(finding))}; Path=/; Max-Age=${DUP_TTL_SECONDS}; SameSite=Lax`
  );
}

function clearDuplicateFinding(res) {
  res.append('Set-Cookie', `${DUP_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`);
}

// Returns the finding only when it is about THIS person; anything unparseable
// or stale is treated as absent. Shape: { p, n, f, c: [{ i, r, s }] }.
function readDuplicateFinding(req, personId) {
  const raw = readCookie(req, DUP_COOKIE, 2000);
  if (!raw) return null;
  try {
    const finding = JSON.parse(raw);
    if (!finding || String(finding.p) !== String(personId)) return null;
    return {
      sameName: !!finding.n,
      priorPhotoId: Number(finding.f) || 0,
      candidates: (Array.isArray(finding.c) ? finding.c : []).slice(0, 4)
    };
  } catch {
    return null;
  }
}

// Shown on the person page right after a report that looks like it may already
// exist. It is a WARNING, not a rejection and not a decision: the report is
// already saved and public by the time this renders, and nothing here changes
// a record. It exists so the reporter — and anyone reading the page — can SEE
// the other report and act on it out of band.
//
// Reconciling the two records (merging them, or splitting a namesake apart) is
// deliberately absent: those are irreversible mutations of public records and
// there is no way to prove, from a cookie, that the caller is entitled to make
// them. That belongs behind a real authorization, not here.
function duplicateNotice({ person, sameName, priorPhoto, candidates }) {
  // The question only makes sense next to a face — and `facePlate` renders
  // nothing without a thumbnail, so ask on the SAME condition it draws on.
  // Branching on the row alone printed "compare the photos" over a blank card.
  const showsFace = (photo) => !!(photo && photo.thumb_type);
  const compare = (photo) =>
    showsFace(photo)
      ? '<p class="dup-q">Compara las fotos: si es la misma persona, escríbenos y unimos los reportes.</p>'
      : '<p class="dup-q">Ese reporte no tiene foto para comparar.</p>';

  // The record we landed on because the NAMES matched. It may be the same
  // person (good — the reports are already together) or a namesake, which is
  // the dangerous case: a rescuer would be shown the wrong family's contact.
  const sameNameCard = sameName
    ? `<article class="card dup">
  ${facePlate(priorPhoto, person.full_name)}
  <p>🔤 <strong>Ya había un reporte con este mismo nombre</strong>, así que este se sumó a ese registro.</p>
  ${compare(priorPhoto)}
  <p class="subtle">Si <strong>no</strong> es la misma persona —dos personas distintas con el mismo nombre— escríbenos a <a href="mailto:a@torrenegra.com">a@torrenegra.com</a> para separarlos: si quedan juntos, un rescatista vería los datos de la familia equivocada.</p>
</article>`
      : '';

  // A 97% facial match and a name that merely scored 0.61 are not the same
  // evidence, and an anxious family reads whatever it is shown as certainty.
  // Say which signal fired, and how strong it was.
  const why = (c) =>
    c.reason === 'face' && c.similarity
      ? `👤 La foto coincide en un <strong>${c.similarity}%</strong> con este otro reporte.`
      : '🔤 El nombre se parece al de este otro reporte. Es una pista débil: revisa la foto.';

  const otherCards = candidates
    .map(
      (c) => `<article class="card dup">
  ${facePlate(c.photo, c.person.full_name)}
  <h3><a href="/person/${c.person.id}">${esc(c.person.full_name)}</a></h3>
  <p>${why(c)}</p>
  ${c.update && c.update.location ? `<p class="loc">📍 ${esc(c.update.location)}</p>` : ''}
  ${compare(c.photo)}
</article>`
    )
    .join('');

  if (!sameNameCard && !otherCards) return '';

  return `<div class="warning">
  <p>⚠️ <strong>Puede que esta persona ya estuviera reportada.</strong> Los reportes repartidos en dos fichas son un problema real: quien la rescate vería el contacto de una sola familia, y la otra nunca recibe la llamada.</p>
</div>
${sameNameCard}
${otherCards}`;
}

const REPORT_PRIVACY = `<p class="privacy">📢 Las fotos del reporte <strong>se publican</strong> en la lista de personas desaparecidas, con los puntos de reconocimiento facial marcados sobre el rostro. Es lo que permite que un rescatista reconozca a la persona que tiene al lado. Sube solo fotos que quieras hacer públicas.</p>`;

// Photos stored before thumbnails existed catch up on their own, so nobody has
// to run a maintenance command for the listing to start showing faces.
//
// Bounded and throttled: one small batch per minute per instance, kicked off
// AFTER the page has been sent so it never delays anyone. It stops costing
// anything once there is nothing pending — and on a serverless instance that
// gets frozen mid-sweep, the work is idempotent and simply resumes next time.
const SWEEP_INTERVAL_MS = 60000;
const SWEEP_BATCH = 5;
// Names are a cheap text scan, no image work, so a bigger batch is free.
const SWEEP_NAMES = 200;

// State per app, not per module: a serverless instance builds exactly one app,
// so the throttle behaves the same in production — and two apps in one process
// (the test suite) don't throttle each other.
function createSweeper(store, matcher) {
  let lastSweep = 0;
  let sweeping = false;
  return function sweep() {
    const now = Date.now();
    if (sweeping || now - lastSweep < SWEEP_INTERVAL_MS) return;
    lastSweep = now;
    sweeping = true;
    Promise.all([
      backfillPhotoDerivatives(store, matcher, SWEEP_BATCH),
      store.recasePersonNames(SWEEP_NAMES)
    ])
      .then(([, names]) => {
        if (names.fixed.length) console.log(`[nombres] recapitalizados ${names.fixed.length}`);
      })
      .catch((e) => console.error('[mantenimiento] barrido automático falló:', e.message))
      .finally(() => {
        sweeping = false;
      });
  };
}

function webRoutes(store, matcher) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: true }));
  const sweepPhotoDerivatives = createSweeper(store, matcher);

  // ---------------------------------------------------------------- home
  router.get(
    '/',
    wrap(async (req, res) => {
      const missing = await store.getMissingPeople(50);
      const photos = await store.reportPhotoByPerson(missing.map((p) => p.id));
      const list = missing.length
        ? `<h2>Reportes de desaparecidos más recientes</h2>${SOURCES_NOTE}` +
          missing
            .map((p) => {
              return `<article class="card person">
  <div class="person-info">
    <h3><a href="/person/${p.id}">${esc(p.full_name)}</a></h3>
    <p class="meta">Último reporte: ${timeTag(p.last_report)}</p>
  </div>
  ${facePlate(photos.get(p.id), p.full_name)}
</article>`;
            })
            .join('')
        : `<p class="subtle">Todavía no hay personas reportadas como desaparecidas.</p>${SOURCES_NOTE}`;

      res.send(
        layout(
          'Inicio',
          `
<section class="action-group">
  <h1>Voluntarios, rescatistas, bomberos, policías y hospitales:</h1>
  <a class="big-btn report" href="/rescate">
    <span class="btn-title">🔍 Mira quién está buscando la persona que rescataste</span>
    <span class="btn-sub">Subes una foto, la comparamos con IA y la borramos al instante</span>
  </a>
</section>
<section class="action-group">
  <h2>¿Buscas un ser querido?</h2>
  <a class="big-btn search" href="/report">
    <span class="btn-title">📢 Reporta desaparecido</span>
  </a>
</section>
${list}
`,
          {
            fullTitle:
              'Voluntarios, rescatistas, bomberos, policías y hospitales — encontrados.co',
            description:
              'Si rescataste a alguien, sube su foto y te decimos quién la está buscando. La foto se borra de inmediato. También puedes reportar a una persona desaparecida.',
            path: '/'
          }
        )
      );

      // Page already sent: catching old photos up costs this visitor nothing.
      sweepPhotoDerivatives();
    })
  );

  // ------------------------------------------------------------- photos
  // Serves REPORT photos only. A rescuer's photo ('query') is never served:
  // its bytes were dropped at upload, so there is nothing here to return —
  // this route enforces that rather than relying on the row being empty.
  async function sendPhoto(req, res, pick) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).end();
    const photo = await store.getPhoto(id);
    if (!photo || photo.kind !== 'report') return res.status(404).end();
    const { raw, contentType } = pick(photo);
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || '');
    if (!bytes.length) return res.status(404).end();
    res.set('Content-Type', contentType || 'image/jpeg');
    // Photos never change once stored, and a re-request on a bad connection is
    // exactly what this page cannot afford.
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(bytes);
  }

  router.get(
    '/photo/:id',
    wrap((req, res) => sendPhoto(req, res, (p) => ({ raw: p.content, contentType: p.content_type })))
  );

  // The small face crop the public listing loads — a few KB instead of a few
  // hundred. Falls back to nothing (404) rather than serving the full photo:
  // a visitor on a weak connection must never get the big one by accident.
  router.get(
    '/photo/:id/thumb',
    wrap((req, res) => sendPhoto(req, res, (p) => ({ raw: p.thumb, contentType: p.thumb_type })))
  );

  // The same crop at 480px, for the person page — one face shown at 240 CSS px
  // wants to be sharp on a phone screen, where the listing's 80px copy would
  // look like mush.
  router.get(
    '/photo/:id/face',
    wrap((req, res) =>
      sendPhoto(req, res, (p) => ({ raw: p.thumb_large || p.thumb, contentType: p.thumb_type }))
    )
  );

  // Manual version of the sweep above, openable in a browser. Unlike
  // /api/reindex this needs no API key, and it is safe without one: it never
  // notifies anybody, never calls IndexFaces (so it cannot duplicate a face in
  // the collection), and only touches photos that are still missing a
  // thumbnail or their geometry — once they all have both, it does nothing and
  // costs nothing, however many times it is called.
  router.all(
    ['/mantenimiento', '/fotos/actualizar'],
    wrap(async (req, res) => {
      const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 500);
      const r = await backfillPhotoDerivatives(store, matcher, limit);
      const names = await store.recasePersonNames(500);
      res.send(
        layout(
          'Poner al día',
          `<h1 class="compact">Poner al día</h1>
<h2>Nombres</h2>
${
  names.fixed.length
    ? `<p>✅ Recapitalizados <strong>${names.fixed.length}</strong> de ${names.checked} nombres.</p>
<ul class="subtle">${names.fixed
        .slice(0, 10)
        .map((f) => `<li>${esc(f.from)} → <strong>${esc(f.to)}</strong></li>`)
        .join('')}</ul>`
    : `<p>✅ Los ${names.checked} nombres ya están bien escritos.</p>`
}
<h2>Fotos</h2>
${
  r.processed === 0
    ? '<p>✅ <strong>Todas las fotos están al día.</strong> No quedaba nada por hacer.</p>'
    : `<p>✅ Procesadas <strong>${r.processed}</strong> foto(s): ${r.thumbnails} miniatura(s) y ${r.geometry} rostro(s) detectado(s).${
        r.failed ? ` ${r.failed} no se pudo(ieron) procesar.` : ''
      }</p>
<p><a class="big-btn report" href="/mantenimiento?limit=${limit}">Procesar las siguientes ${limit}</a></p>
<p class="subtle">Repite hasta que diga que están todas al día. También ocurre solo, poco a poco, a medida que la gente visita el inicio.</p>`
}
${
  r.waiting
    ? `<p class="privacy">⚠️ ${r.waiting} foto(s) ya tienen miniatura con recorte centrado, pero les falta ubicar el rostro y el reconocimiento facial no está activo. Cuando vuelva, ejecuta esto otra vez y se reencuadran sobre la cara.</p>`
    : ''
}
<p><a href="/">← Volver al inicio</a></p>`,
          { path: '/mantenimiento' }
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
          fullTitle: 'Mira quién está buscando a la persona que rescataste — encontrados.co',
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

      const { available, matches } = await identifyRescuedPerson(store, matcher, {
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
  <p>${
    sub
      ? 'Te avisaremos por correo apenas alguien la busque (confirma tu correo con el enlace que te enviamos).'
      : 'Vuelve a intentarlo más tarde, o déjanos tu correo para avisarte apenas alguien la busque.'
  }</p>
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
<p><a class="big-btn report" href="/rescate">🔍 Consultar otra persona</a></p>`
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
          fullTitle: 'Reportar una persona desaparecida — encontrados.co',
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

      const { person, created } = await store.findOrCreatePerson(name);

      // Read the record's existing photo BEFORE this report's own photos are
      // stored below — afterwards there is no way to tell, from the person id
      // alone, which face was already there and which one just arrived. That
      // pre-existing face is the whole point of the comparison.
      const priorPhoto = created ? null : (await store.reportPhotoByPerson([person.id])).get(person.id);

      const update = await store.addUpdate(person.id, {
        status: 'missing',
        message,
        location,
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

      // Duplicate detection runs LAST, once the report is durable. Everything
      // above is the family's data; everything here is a courtesy. Running the
      // face searches first meant a slow Rekognition call — or a serverless
      // timeout inside it — could take the whole report down with it, which is
      // the one outcome this service must never produce. The photos are already
      // indexed by now and would match themselves, but `excludePersonId` drops
      // every hit on this record, so self-matching is a non-issue.
      const candidates = await findDuplicateCandidates(store, matcher, {
        name,
        photos: files.map((f) => f.buffer),
        excludePersonId: person.id
      });

      // Two different ways this report can be a duplicate:
      //   created === false → the NAME matched, so it was appended to a record
      //     that may or may not be the same human;
      //   candidates        → a FACE matched a report filed under another name,
      //     which is now a second record for one person.
      //
      // Either way the answer is a 303, never a page rendered onto the POST:
      // this handler stores photos and pays for a face index per photo, so a
      // reload of its response would manufacture the very duplicate it warns
      // about. The finding travels in a short-lived COOKIE, not in the URL: a
      // link is shareable and a cookie is not, and this warning asserts that
      // two specific missing people may be the same person — a claim only the
      // server is entitled to make, and only for the visitor who just reported.
      if (candidates.length || !created) {
        rememberDuplicateFinding(res, {
          p: person.id,
          n: created ? 0 : 1,
          f: priorPhoto ? priorPhoto.id : 0,
          c: candidates.map((c) => ({ i: c.person.id, r: c.reason, s: c.similarity }))
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
      const photo = (await store.reportPhotoByPerson([person.id])).get(person.id);
      // Only worth a banner when the newest report ISN'T the located one —
      // otherwise it just repeats the card right below it.
      const lastLocated = updates.find((u) => u.location);
      const locationIsBuried = lastLocated && lastLocated !== updates[0];

      // Possible-duplicate warning for the visitor who just filed this report.
      // It comes from the cookie POST /report set, never from the URL — see
      // DUP_COOKIE above for why. Shown once, then cleared.
      const finding = readDuplicateFinding(req, person.id);
      let duplicates = '';
      if (finding) {
        clearDuplicateFinding(res);
        const wanted = finding.candidates.filter(
          (c) => Number.isInteger(Number(c.i)) && Number(c.i) > 0 && String(c.i) !== String(person.id)
        );
        const dupPhotos = await store.reportPhotoByPerson(wanted.map((c) => Number(c.i)));
        const candidates = (
          await Promise.all(
            wanted.map(async (c) => {
              const other = await store.getPerson(Number(c.i));
              if (!other) return null;
              return {
                person: other,
                photo: dupPhotos.get(Number(c.i)) || null,
                update: await store.getLatestUpdate(Number(c.i)),
                // A 97% facial match and a name that merely scored 0.61 are not
                // the same evidence, and an anxious family reads this card as
                // if they were. Keep them distinguishable.
                reason: c.r === 'face' ? 'face' : 'name',
                similarity: Number(c.s) || null
              };
            })
          )
        ).filter(Boolean);

        let priorPhoto = null;
        if (finding.priorPhotoId) {
          // Metadata only — `getPhoto` would drag the full image and both
          // thumbnails out of Postgres just to read `thumb_type`.
          const p = await store.getReportPhotoMeta(finding.priorPhotoId);
          // Same guard as GET /photo/:id — a rescuer's photo is never rendered.
          if (p && p.kind === 'report' && String(p.person_id) === String(person.id)) priorPhoto = p;
        }
        duplicates = duplicateNotice({
          person,
          sameName: finding.sameName,
          priorPhoto,
          candidates
        });
      }

      res.send(
        layout(
          person.full_name,
          `
${req.query.reported ? '<p class="notice">✅ Reporte registrado. Cuando un rescatista tenga a esta persona, verá tus datos de contacto.</p>' : ''}
${duplicates}
<div class="person-body">
  <h1>${esc(person.full_name)}</h1>
  <div class="person-updates">
${locationIsBuried ? `<p class="notice">📍 Última ubicación reportada: <strong>${esc(lastLocated.location)}</strong> (${timeTag(lastLocated.created_at)})</p>` : ''}
${updates.length ? updates.map((u) => updateCard(u)).join('') : '<p class="subtle">Sin reportes todavía.</p>'}
  </div>
  ${facePlate(photo, person.full_name, { large: true })}
</div>
<p class="subtle">Los datos de contacto de quien reporta solo se muestran a un rescatista cuando el rostro coincide.</p>
<p><a class="big-btn report" href="/rescate">🔍 ¿La tienes contigo? Mira quién la busca</a></p>`,
          {
            fullTitle: `${person.full_name} — reportada como desaparecida · encontrados.co`,
            description: `${person.full_name} fue reportada como desaparecida tras el terremoto en Colombia. Si la rescataste, encontrados.co te dice quién la está buscando.`,
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
        { fullTitle: 'Revisa tu correo — encontrados.co' }
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
          { fullTitle: 'Aviso confirmado — encontrados.co' }
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
<p><strong>encontrados.co</strong> existe con un único propósito: que un rescatista que tiene a una persona a su lado pueda encontrar a quien la está buscando, tras el terremoto en Colombia del lunes 10 de agosto.</p>

<h2>La foto del rescatista no se guarda</h2>
<p>Cuando un rescatista sube la foto de la persona que tiene consigo, esa imagen se compara al instante y <strong>se borra de inmediato</strong>. No queda almacenada en ningún servidor y no se muestra en ninguna parte. Solo conservamos sus <em>metadatos faciales</em>: la firma facial —un código matemático que permite comparar rostros pero <strong>no permite reconstruir la fotografía</strong>— para poder avisarle si más adelante alguien reporta a esa persona como desaparecida.</p>

<h2>Las fotos de los reportes sí se publican</h2>
<p>Es distinto cuando reportas a una persona desaparecida: esas fotos <strong>se guardan y se muestran públicamente</strong> en la lista de personas desaparecidas, junto con los puntos de reconocimiento facial que el sistema detecta sobre el rostro. Ese es justamente el propósito del reporte: que cualquier rescatista pueda reconocer a la persona que tiene al lado. Sube únicamente fotos que quieras hacer públicas. Para eliminar un reporte o sus fotos, escribe a <a href="mailto:a@torrenegra.com">a@torrenegra.com</a>.</p>

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
  <li>No usamos las fotos para nada distinto a lo descrito aquí: comparar rostros y, en el caso de los reportes, mostrar a la persona buscada.</li>
</ul>`,
        { fullTitle: 'Política de privacidad — encontrados.co', path: '/privacidad' }
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
<p><strong>encontrados.co</strong> es un servicio gratuito y de emergencia que conecta a quien rescata a una persona con quien la está buscando. Al usarlo aceptas estos términos, deliberadamente simples dada la naturaleza de la emergencia:</p>
<ul>
  <li><strong>Úsalo de buena fe.</strong> Reporta solo información que creas cierta. Está prohibido publicar datos falsos o usar el servicio para localizar a alguien que no quiere ser encontrado.</li>
  <li><strong>Los datos de contacto son para reunir familias.</strong> Al mostrarse tras una coincidencia facial, deben usarse únicamente para informar sobre la persona; cualquier otro uso está prohibido.</li>
  <li><strong>Verifica antes de actuar.</strong> El reconocimiento facial es una ayuda, no una prueba: una coincidencia puede ser errónea. Confirma siempre la identidad por otros medios.</li>
  <li><strong>Sin garantías.</strong> El servicio se ofrece "tal cual", sin garantía de disponibilidad ni exactitud, y no sustituye a las autoridades ni a los organismos de socorro.</li>
  <li><strong>Podemos retirar contenido</strong> que incumpla estos términos y atender solicitudes de eliminación en <a href="mailto:a@torrenegra.com">a@torrenegra.com</a>.</li>
</ul>`,
        { fullTitle: 'Términos de servicio — encontrados.co', path: '/terminos' }
      )
    );
  });

  // ------------------------------------------------------------ api docs
  router.get(['/api-doc', '/api-docs'], (req, res) => {
    res.send(
      layout(
        'API',
        `
<h1>API de encontrados.co</h1>
<p>Base: <code>https://encontrados.co/api</code> · JSON. Pensada para organismos de socorro que quieran reportar en lote.</p>

<h2>Reportar una persona desaparecida</h2>
<pre>curl -X POST https://encontrados.co/api/updates \\
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

<h2>Duplicados</h2>
<p>La respuesta <code>201</code> incluye siempre un bloque <code>duplicate</code>. <strong>Es un aviso, nunca un rechazo</strong>: el reporte queda guardado pase lo que pase.</p>
<pre>{
  "person_id": 42,
  "person_created": false,
  "duplicate": {
    "merged_into_existing_person": true,
    "candidates": [
      { "person_id": 17, "full_name": "Juan Carlos Pérez",
        "reason": "face", "similarity": 97, "name_score": null,
        "url": "https://encontrados.co/person/17" }
    ],
    "warning": "Ya existía una persona con este nombre: …"
  }
}</pre>
<ul>
  <li><code>merged_into_existing_person</code>: el reporte se sumó al historial de alguien ya registrado en vez de crear una persona nueva.</li>
  <li><code>candidates</code>: otros reportes que parecen ser la misma persona.</li>
  <li><code>reason: "face"</code> — coincidencia facial. Trae <code>similarity</code> (% de coincidencia de rostro) y <code>name_score: null</code>. Es la señal fuerte.</li>
  <li><code>reason: "name"</code> — nombre parecido. Trae <code>name_score</code> (0 a 1, similitud difusa de texto) y <code>similarity: null</code>. <strong>Es una señal débil y no es comparable con la facial</strong>: no las mezcles en un mismo umbral — «Juan Carlos Pérez» y «Juan Camilo Pérez» puntúan alto y son dos personas distintas.</li>
  <li><code>warning</code>: la misma información en una frase, o <code>null</code> si no hay nada que advertir.</li>
</ul>
<p class="subtle">Si reportas en lote, usa <code>external_id</code> para que un reenvío del mismo registro actualice el reporte en vez de duplicarlo.</p>

<h2>Consultar</h2>
<pre>curl 'https://encontrados.co/api/people?q=jaun%20peres'
curl https://encontrados.co/api/people/12</pre>

<p class="subtle">Publica solo información que creas cierta — ver <a href="/terminos">términos</a> y <a href="/privacidad">privacidad</a>.</p>`,
        { fullTitle: 'API — encontrados.co', path: '/api-doc' }
      )
    );
  });

  return router;
}

module.exports = { webRoutes };
