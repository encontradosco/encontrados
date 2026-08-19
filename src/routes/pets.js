const express = require('express');
const { upload } = require('../upload');
const { esc, layout, timeTag } = require('../html');
const { processPetPhoto } = require('../petmatch');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const MAX_PET_REPORT_PHOTOS = 3;
const SPECIES_LABEL = { dog: 'Perro', cat: 'Gato' };

function parseSpecies(raw) {
  return raw === 'dog' || raw === 'cat' ? raw : null;
}

// Mismo criterio que composeContact() en src/routes/web.js — con uno basta.
// No se reusa esa función porque no está exportada y son tres líneas: menos
// riesgo copiarlas que abrir el módulo de personas por esto.
function composeContact({ phone, email }) {
  return [phone, email].map((v) => String(v || '').trim()).filter(Boolean).join(' · ');
}

// Espejo de facePlate() en src/html.js, pero sin la geometría facial: una
// mascota no tiene bounding box ni landmarks que dibujar encima, así que acá
// no hay overlay — el resto (el div "pending" con data-src, el botón de
// "ver foto", el <noscript>) es exactamente lo mismo, y PHOTO_SCRIPT (ya
// incluido en layout() en cada página) lo hidrata sin ningún cambio: ese
// script solo mira `.face.pending[data-src]`, nunca de qué se trata la foto.
function petFacePlate(photo, label) {
  if (!photo || !photo.thumb_type) return '';
  const alt = `Foto de ${label}`;
  const src = `/pet-photo/${photo.id}/thumb`;
  return `<div class="face pending" data-src="${src}" data-alt="${esc(alt)}">
  <button type="button" class="face-load" aria-label="Ver la foto de ${esc(label)}" title="Ver foto">📷</button>
  <noscript><img class="face-noscript" src="${src}" alt="${esc(alt)}" width="80" height="80"></noscript>
</div>`;
}

function petRoutes(petStore, petMatcher) {
  const router = express.Router();

  // Espejo de GET '/' en src/routes/web.js: los dos botones de acción arriba,
  // y debajo el listado de lo que sigue perdido — más reciente primero, y el
  // contador de "reencontradas" al lado del título, igual que el de personas.
  router.get(
    '/mascotas',
    wrap(async (req, res) => {
      const [lost, reunited] = await Promise.all([petStore.lostPets(50), petStore.reunitedPetsCount()]);
      const reunitedNote = reunited
        ? ` · <span class="reunited-count">🎉 ${reunited} reencontrada${reunited === 1 ? '' : 's'}</span>`
        : '';
      const photos = await petStore.petPhotosForPets(lost.map((p) => p.id));
      const list = lost.length
        ? `<h2>Mascotas perdidas más recientes${reunitedNote}</h2>` +
          lost
            .map((p) => {
              const label = p.pet_name || `${SPECIES_LABEL[p.species]} perdido`;
              return `<article class="card pet">
  <div class="pet-info">
    <h3><a class="card-link" href="/mascota/${p.id}">${esc(label)}</a></h3>
    <p class="meta">${esc(SPECIES_LABEL[p.species])} · reportada ${timeTag(p.created_at)}</p>
    <a class="card-cta" href="/mascotas/encontre" aria-label="Creo que la vi: ${esc(label)} — compara una foto">👀 Creo que la vi</a>
  </div>
  ${petFacePlate(photos.get(p.id), label)}
</article>`;
            })
            .join('')
        : `<p class="subtle">Todavía no hay mascotas reportadas como perdidas.${
            reunited ? ` 🎉 ${reunited} reencontrada${reunited === 1 ? '' : 's'}.` : ''
          }</p>`;

      res.send(
        layout(
          'Mascotas perdidas',
          `<h1 class="compact">Mascotas perdidas</h1>
<p class="subtle">Comparamos fotos de mascotas para ayudar a reunirlas con su familia.</p>
<div class="stack">
  <a class="big-btn search" href="/mascotas/reporte">🐾 Perdí una mascota</a>
  <a class="big-btn secondary" href="/mascotas/encontre">👀 Encontré una mascota</a>
</div>
${list}`,
          { fullTitle: 'Mascotas perdidas — encontrados.co', path: '/mascotas' }
        )
      );
    })
  );

  function reportForm() {
    return `<form class="stack compact" method="post" action="/mascotas/reporte" enctype="multipart/form-data" data-require-photos>
  <label class="file-label"><span>📷 Fotos de tu mascota * (1 a 3)</span>
    <input type="file" name="photos" accept="image/*" multiple required></label>
  <label class="field-label"><span>Especie *</span>
    <select name="species" required>
      <option value="dog">Perro</option>
      <option value="cat">Gato</option>
    </select></label>
  <label class="field-label"><span>Nombre de tu mascota (opcional)</span>
    <input name="pet_name" maxlength="120" placeholder="Ej. Toby"></label>
  <label class="field-label"><span>Descripción (color, tamaño, señas)</span>
    <textarea name="description" rows="2" placeholder="Ej. Perro mediano, negro, collar rojo"></textarea></label>
  <label class="field-label"><span>Tu teléfono para que te contacten</span>
    <input name="contact_phone" inputmode="tel" autocomplete="tel" maxlength="120" placeholder="Ej. 300 123 4567"></label>
  <label class="field-label"><span>Tu correo</span>
    <input name="contact_email" type="email" inputmode="email" autocomplete="email" maxlength="120" placeholder="tucorreo@ejemplo.com"></label>
  <p class="subtle contact-note">Con uno basta.</p>
  <button>Reporta mascota perdida</button>
</form>
<script>
document.addEventListener('submit', function (ev) {
  var f = ev.target;
  if (!f.matches('form[data-require-photos]')) return;
  if (!f.querySelector('input[type=file]').files.length) {
    ev.preventDefault();
    ev.stopImmediatePropagation();
    alert('Sube al menos una foto de tu mascota.');
  }
}, true);
</script>`;
  }

  router.get('/mascotas/reporte', (req, res) => {
    res.send(
      layout('Reporta tu mascota perdida', `<h1 class="compact">Reporta tu mascota perdida</h1>
<p class="subtle">Cuando alguien que encontró una mascota parecida la compare, verá tu contacto y podrá avisarte.</p>
${reportForm()}`, { fullTitle: 'Reporta tu mascota perdida — encontrados.co', path: '/mascotas/reporte' })
    );
  });

  router.post(
    '/mascotas/reporte',
    upload.array('photos', 8),
    wrap(async (req, res) => {
      const species = parseSpecies(req.body.species);
      const petName = String(req.body.pet_name || '').trim();
      const description = String(req.body.description || '').trim();
      const contact = composeContact({ phone: req.body.contact_phone, email: req.body.contact_email });
      const files = (req.files || []).slice(0, MAX_PET_REPORT_PHOTOS);
      if (!species || !contact || !files.length) {
        return res
          .status(400)
          .send(layout('Error', '<p class="error">Faltan datos: hacen falta las fotos, la especie y un teléfono o correo de contacto.</p>'));
      }

      const pet = await petStore.addPet({ species, petName: petName || null, description: description || null, contact });
      let unreadable = 0;
      for (const f of files) {
        const { photo } = await processPetPhoto(petStore, petMatcher, {
          petId: pet.id,
          kind: 'report',
          species,
          bytes: f.buffer,
          contentType: f.mimetype
        });
        if (photo.unreadable) unreadable++;
      }
      const flag = unreadable ? `&fotos_ilegibles=${unreadable}` : '';
      res.redirect(303, `/mascota/${pet.id}?reported=1${flag}`);
    })
  );

  router.get('/mascotas/encontre', (req, res) => {
    res.send(
      layout('¿Encontraste una mascota?', `<h1 class="compact">¿Encontraste una mascota? Mira si alguien la está buscando</h1>
<p class="subtle">Sube una foto de la mascota. La comparamos con las fotos de mascotas reportadas como perdidas y te mostramos el contacto de quien la busca.</p>
<form class="stack compact" method="post" action="/mascotas/encontre" enctype="multipart/form-data">
  <label class="field-label"><span>Especie *</span>
    <select name="species" required>
      <option value="dog">Perro</option>
      <option value="cat">Gato</option>
    </select></label>
  <label class="file-label"><span>📷 Foto de la mascota *</span>
    <input type="file" name="photo" accept="image/*" required></label>
  <button>Comparar</button>
</form>`, { fullTitle: '¿Encontraste una mascota? — encontrados.co', path: '/mascotas/encontre' })
    );
  });

  router.post(
    '/mascotas/encontre',
    upload.single('photo'),
    wrap(async (req, res) => {
      const species = parseSpecies(req.body.species);
      if (!species || !req.file) {
        return res.status(400).send(layout('Error', '<p class="error">Sube una foto y elige la especie.</p>'));
      }

      const { photo, matches } = await processPetPhoto(petStore, petMatcher, {
        kind: 'query',
        species,
        bytes: req.file.buffer,
        contentType: req.file.mimetype
      });

      let body;
      if (photo.unreadable) {
        body = '<div class="error"><p><strong>No pudimos leer esa foto.</strong> Intenta con otra.</p></div>';
      } else if (!petMatcher.enabled) {
        body = '<div class="error"><p>La comparación de mascotas no está disponible en este momento. Inténtalo de nuevo en unos minutos.</p></div>';
      } else if (!matches.length) {
        body = '<div class="error"><p><strong>Nadie ha reportado una mascota parecida todavía.</strong> Vuelve a intentarlo más tarde.</p></div>';
      } else {
        const cards = [];
        for (const m of matches) {
          const pet = await petStore.getPet(m.pet_id);
          if (!pet) continue;
          const label = pet.pet_name || `${SPECIES_LABEL[pet.species]} perdido`;
          cards.push(`<article class="card">
  <h3><a href="/mascota/${pet.id}">${esc(label)}</a></h3>
  <p>🐾 Coincidencia: <strong>${Math.round(m.similarity)}%</strong></p>
  <p><strong>Contacta a quien la busca:</strong> ${esc(pet.contact)}</p>
</article>`);
        }
        body =
          `<h2>${cards.length === 1 ? 'Puede ser esta' : 'Coincidencias encontradas'}</h2>` +
          cards.join('') +
          '<p class="subtle">Verifica siempre antes de entregar la mascota.</p>';
      }

      res.send(
        layout('Resultado', `<h1 class="compact">Resultado</h1>
${body}
<p><a href="/mascotas/encontre">🔍 Consultar otra mascota</a></p>`)
      );
    })
  );

  router.get(
    '/mascota/:id',
    wrap(async (req, res) => {
      const pet = await petStore.getPet(req.params.id);
      if (!pet) return res.status(404).send(layout('No encontrado', '<p>No existe esa mascota.</p>'));
      const photos = await petStore.petPhotosForPet(pet.id);
      const label = pet.pet_name || `${SPECIES_LABEL[pet.species]} perdido`;
      // Una foto que processPetPhoto marcó `unreadable` nunca llegó a tener
      // miniatura (esa etapa ni corre para ella) — un <img> apuntando a
      // /pet-photo/:id/thumb para esa fila siempre da 404. Mismo dato,
      // `thumb_type`, que ya trae petPhotosForPet.
      const imgs = photos
        .map((p) =>
          p.thumb_type
            ? `<img src="/pet-photo/${p.id}/thumb" alt="Foto de ${esc(label)}" width="240" height="240">`
            : '<p class="subtle">📷 Foto no disponible.</p>'
        )
        .join('');
      const action = pet.resolved_at
        ? '<p class="notice">✅ Esta mascota ya fue encontrada.</p>'
        : `<form method="post" action="/mascota/${pet.id}/encontrado"><button class="secondary">Marcar como encontrada</button></form>`;
      res.send(
        layout(label, `<h1 class="compact">${esc(label)}</h1>
${req.query.reported ? '<p class="notice">✅ Reporte registrado. Cuando alguien que encontró una mascota parecida la compare, verá tu contacto y podrá avisarte.</p>' : ''}
${
  req.query.fotos_ilegibles
    ? `<div class="error"><p><strong>Ojo: no pudimos leer ${Number(req.query.fotos_ilegibles) === 1 ? 'una de las fotos' : 'algunas de las fotos'} que subiste.</strong> El reporte quedó registrado, pero esa foto no sirve para compararla con otras mascotas.</p></div>`
    : ''
}
<p>${esc(SPECIES_LABEL[pet.species])}${pet.description ? ' · ' + esc(pet.description) : ''}</p>
${imgs}
${action}`, { path: `/mascota/${pet.id}` })
      );
    })
  );

  router.post(
    '/mascota/:id/encontrado',
    wrap(async (req, res) => {
      const pet = await petStore.getPet(req.params.id);
      if (!pet) return res.status(404).end();
      await petStore.markPetResolved(pet.id);
      res.redirect(303, `/mascota/${pet.id}`);
    })
  );

  router.get(
    '/pet-photo/:id',
    wrap(async (req, res) => {
      const photo = await petStore.getPetPhoto(req.params.id);
      if (!photo || photo.kind !== 'report' || !photo.content || !photo.content.length) {
        return res.status(404).end();
      }
      res.set('Content-Type', photo.content_type);
      res.send(Buffer.isBuffer(photo.content) ? photo.content : Buffer.from(photo.content));
    })
  );

  router.get(
    '/pet-photo/:id/thumb',
    wrap(async (req, res) => {
      const photo = await petStore.getPetPhoto(req.params.id);
      if (!photo || photo.kind !== 'report' || !photo.thumb || !photo.thumb.length) {
        return res.status(404).end();
      }
      res.set('Content-Type', photo.thumb_type || 'image/jpeg');
      res.send(Buffer.isBuffer(photo.thumb) ? photo.thumb : Buffer.from(photo.thumb));
    })
  );

  return router;
}

module.exports = { petRoutes };
