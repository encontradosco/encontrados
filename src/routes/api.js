const express = require('express');
const env = require('../env');
const { notifySubscribers } = require('../notify');
const { STATUSES } = require('../people');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function apiRoutes(store) {
  const router = express.Router();
  router.use(express.json());

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
  // { name, status, message?, location?, reporter? }
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
        source: 'api',
        reporter
      });
      notifySubscribers(store, person, update).catch((e) => console.error('[api notify]', e));
      res.status(201).json({ person_id: person.id, person_created: created, update });
    })
  );

  // POST /api/people/:id/subscriptions — { channel: email|whatsapp|telegram, address }
  router.post(
    '/people/:id/subscriptions',
    requireKey,
    wrap(async (req, res) => {
      const person = await store.getPerson(req.params.id);
      if (!person) return res.status(404).json({ error: 'Persona no encontrada' });
      const { channel, address } = req.body || {};
      if (!['email', 'whatsapp', 'telegram'].includes(channel)) {
        return res.status(400).json({ error: 'channel debe ser email, whatsapp o telegram' });
      }
      try {
        await store.subscribe(person.id, channel, address);
        res.status(201).json({ ok: true });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    })
  );

  return router;
}

module.exports = { apiRoutes };
