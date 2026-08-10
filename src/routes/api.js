const express = require('express');
const env = require('../env');
const { notifySubscribers, sendVerificationEmail } = require('../notify');
const { STATUSES } = require('../people');
const { processPhoto, backfillUnindexedPhotos, MAX_QUERY_PHOTOS } = require('../facematch');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

// { base64, content_type } → { bytes, contentType } (null if invalid/too big)
function decodePhoto(p) {
  if (!p || typeof p.base64 !== 'string') return null;
  try {
    const bytes = Buffer.from(p.base64, 'base64');
    if (!bytes.length || bytes.length > MAX_PHOTO_BYTES) return null;
    return { bytes, contentType: p.content_type || 'image/jpeg' };
  } catch {
    return null;
  }
}

function apiRoutes(store, matcher) {
  const router = express.Router();
  router.use(express.json({ limit: '16mb' }));

  // If API_KEY is set, writes require `Authorization: Bearer <key>`.
  // Reads stay open — emergency information wants to be found.
  function requireKey(req, res, next) {
    if (!env.API_KEY) return next();
    const auth = req.get('authorization') || '';
    if (auth === `Bearer ${env.API_KEY}`) return next();
    res.status(401).json({ error: 'API key inválida o ausente' });
  }

  // GET /api/people?q=juan perez — fuzzy search
  router.get(
    '/people',
    wrap(async (req, res) => {
      const q = req.query.q || '';
      if (!q.trim()) return res.status(400).json({ error: 'Falta el parámetro q' });
      const matches = await store.searchPeople(q, { limit: 10 });
      const results = await Promise.all(
        matches.map(async (p) => ({
          id: p.id,
          full_name: p.full_name,
          score: p.score,
          latest_update: (await store.getLatestUpdate(p.id)) || null
        }))
      );
      res.json({ results });
    })
  );

  // GET /api/people/:id — person + full timeline
  router.get(
    '/people/:id',
    wrap(async (req, res) => {
      const person = await store.getPerson(req.params.id);
      if (!person) return res.status(404).json({ error: 'Persona no encontrada' });
      res.json({
        id: person.id,
        full_name: person.full_name,
        updates: await store.getUpdates(person.id)
      });
    })
  );

  // POST /api/updates — report status by name (creates the person if new)
  // { name, status, message?, location?, reporter?, photo?: { base64, content_type } }
  // The photo is used ONLY for face matching; it is never displayed or shared.
  router.post(
    '/updates',
    requireKey,
    wrap(async (req, res) => {
      const { name, status, message, location, reporter } = req.body || {};
      if (!name || !String(name).trim()) return res.status(400).json({ error: 'Falta name' });
      if (!STATUSES.includes(status)) {
        return res.status(400).json({ error: `status debe ser uno de: ${STATUSES.join(', ')}` });
      }
      const { person, created } = await store.findOrCreatePerson(name);
      const update = await store.addUpdate(person.id, {
        status,
        message,
        location,
        lat: typeof req.body.lat === 'number' ? req.body.lat : parseFloat(req.body.lat),
        lng: typeof req.body.lng === 'number' ? req.body.lng : parseFloat(req.body.lng),
        source: 'api',
        reporter
      });
      notifySubscribers(store, person, update).catch((e) => console.error('[api notify]', e));
      const photo = decodePhoto(req.body.photo);
      if (photo) {
        await processPhoto(store, matcher, {
          personId: person.id,
          kind: 'report',
          updateId: update.id,
          bytes: photo.bytes,
          contentType: photo.contentType
        });
      }
      res.status(201).json({
        person_id: person.id,
        person_created: created,
        update,
        photo_stored: !!photo
      });
    })
  );

  // POST /api/people/:id/subscriptions —
  // { channel: email|whatsapp, address, photos?: [{ base64, content_type }] (max 3) }
  // Photos are used ONLY for face matching; they are never displayed or shared.
  router.post(
    '/people/:id/subscriptions',
    requireKey,
    wrap(async (req, res) => {
      const person = await store.getPerson(req.params.id);
      if (!person) return res.status(404).json({ error: 'Persona no encontrada' });
      const { channel, address } = req.body || {};
      if (!['email', 'whatsapp'].includes(channel)) {
        return res.status(400).json({ error: 'channel debe ser email o whatsapp' });
      }
      try {
        const { sub, needsVerification } = await store.subscribe(person.id, channel, address);
        let photosStored = 0;
        const photos = Array.isArray(req.body.photos) ? req.body.photos.slice(0, MAX_QUERY_PHOTOS) : [];
        if (sub && photos.length) {
          let count = await store.countQueryPhotos(sub.id);
          for (const raw of photos) {
            const photo = decodePhoto(raw);
            if (!photo || count >= MAX_QUERY_PHOTOS) continue;
            await processPhoto(store, matcher, {
              personId: person.id,
              kind: 'query',
              subscriptionId: sub.id,
              bytes: photo.bytes,
              contentType: photo.contentType
            });
            count++;
            photosStored++;
          }
        }
        if (needsVerification) {
          sendVerificationEmail(person, sub).catch((e) => console.error('[api verify email]', e));
        }
        res.status(201).json({ ok: true, pending_verification: needsVerification, photos_stored: photosStored });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    })
  );

  // POST/GET /api/reindex — index photos stored while matching was down and
  // notify anyone whose search now matches. Safe to run repeatedly.
  router.all(
    '/reindex',
    wrap(async (req, res) => {
      const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 500);
      res.json(await backfillUnindexedPhotos(store, matcher, limit));
    })
  );

  // GET /api/diag — configuration and live self-test. Never exposes secrets.
  // ?email=you@example.com sends a real test email and reports the result.
  router.get(
    '/diag',
    wrap(async (req, res) => {
      if (typeof matcher.ensureReady === 'function') {
        await matcher.ensureReady();
      }
      const out = {
        base_url: env.BASE_URL,
        database: {
          driver: process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.STORAGE_URL ? 'postgres' : 'sqlite (efímero)',
          ok: false
        },
        email: {
          sendgrid_key_present: !!env.SENDGRID_API_KEY,
          from: env.EMAIL_FROM
        },
        faces: {
          aws_key_present: !!process.env.AWS_ACCESS_KEY_ID,
          aws_region: process.env.AWS_REGION || '(sin definir → us-east-1)',
          matcher_enabled: !!matcher.enabled,
          status: matcher.status || 'desconocido'
        }
      };

      try {
        const recent = await store.getRecentUpdates(1);
        out.database.ok = true;
        out.database.recent_updates = recent.length;
        out.database.counts = await store.counts();
        const pending = await store.photosMissingFaceId(500);
        out.faces.photos_pending_indexing = pending.length;
        if (pending.length) {
          out.faces.hint = 'Ejecuta /api/reindex para indexarlas y avisar coincidencias.';
        }
      } catch (e) {
        out.database.error = e.message;
      }

      if (req.query.email) {
        const { sendEmail } = require('../notify');
        out.email.test = await sendEmail(
          String(req.query.email),
          'Prueba de configuración — aqui.online',
          'Si recibes este correo, el envío desde aqui.online funciona correctamente.'
        );
      }

      res.json(out);
    })
  );

  return router;
}

module.exports = { apiRoutes };
