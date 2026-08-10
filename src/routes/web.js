const express = require('express');
const { notifySubscribers, sendVerificationEmail, STATUS_LABEL } = require('../notify');
const { STATUSES } = require('../people');
const { esc, layout, statusBadge, updateCard } = require('../html');

// Express 4 doesn't catch async errors on its own.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function webRoutes(store) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: true }));

  // Home: search + recent updates
  router.get(
    '/',
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
<form class="stack" method="post" action="/subscribe-by-name">
  <input type="hidden" name="name" value="${esc(q)}">
  <label><span>Tu correo electrónico</span><input type="email" name="email" required placeholder="tucorreo@ejemplo.com"></label>
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
      const recent = await store.getRecentUpdates(10);
      res.send(
        layout(
          'Buscar',
          `
<h1>¿Buscas a alguien?</h1>
<form method="get" action="/" class="search-row">
  <input type="search" name="q" value="${esc(q)}" placeholder="Nombre de la persona (ej. Juan Pérez)" required>
  <button>Buscar</button>
</form>
<p class="subtle">No importa si no recuerdas el nombre exacto: buscamos por similitud y pronunciación.</p>
${resultsHtml}
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

  // Report form
  router.get('/report', (req, res) => {
    const options = STATUSES.map(
      (s) => `<option value="${s}">${esc(STATUS_LABEL[s])}</option>`
    ).join('');
    res.send(
      layout(
        'Reportar estado',
        `
<h1>Reportar el estado de una persona</h1>
<form class="stack" method="post" action="/report">
  <label><span>Nombre completo de la persona *</span>
    <input name="name" required value="${esc(req.query.name || '')}" placeholder="Juan Carlos Pérez"></label>
  <label><span>Estado *</span><select name="status" required>${options}</select></label>
  <label><span>Nota (qué sabes, cuándo, cómo)</span>
    <textarea name="message" rows="3" placeholder="Hablé con él a las 3pm, está en el albergue"></textarea></label>
  <label><span>Ubicación</span><input name="location" placeholder="Albergue San José, Mocoa"></label>
  <label><span>Tu nombre o teléfono (opcional)</span><input name="reporter" placeholder="María Gómez, 300 123 4567"></label>
  <button>Enviar reporte</button>
</form>`
      )
    );
  });

  router.post(
    '/report',
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
        source: 'web',
        reporter
      });
      notifySubscribers(store, person, update).catch((e) => console.error('[web notify]', e));
      res.redirect(`/person/${person.id}?reported=1`);
    })
  );

  // Person page: timeline + email subscription
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
<form class="stack" method="post" action="/person/${person.id}/subscribe">
  <label><span>Tu correo electrónico</span>
    <input type="email" name="email" required placeholder="tucorreo@ejemplo.com"></label>
  <button>🔔 Suscribirme a novedades de ${esc(person.full_name)}</button>
</form>
<p><a href="/report?name=${encodeURIComponent(person.full_name)}">➕ Agregar un nuevo reporte sobre esta persona</a></p>`
        )
      );
    })
  );

  router.post(
    '/person/:id/subscribe',
    wrap(async (req, res) => {
      const person = await store.getPerson(req.params.id);
      if (!person) {
        return res.status(404).send(layout('No encontrado', '<p class="error">Persona no encontrada.</p>'));
      }
      const email = (req.body.email || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).send(layout('Error', '<p class="error">Correo inválido.</p>'));
      }
      const { sub, needsVerification } = await store.subscribe(person.id, 'email', email);
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
    wrap(async (req, res) => {
      const { name, email } = req.body;
      if (!name || !name.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((email || '').trim())) {
        return res.status(400).send(layout('Error', '<p class="error">Faltan datos.</p>'));
      }
      const { person } = await store.findOrCreatePerson(name);
      const { sub, needsVerification } = await store.subscribe(person.id, 'email', email.trim());
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

  return router;
}

module.exports = { webRoutes };
