const express = require('express');
const env = require('../env');
const {
  sendVerificationEmail,
  notifyMode,
  relayEnabled,
  avisoEmail
} = require('../notify');
const { STATUSES } = require('../people');
const {
  processPhoto,
  forgetPersonFaces,
  backfillUnindexedPhotos,
  backfillPhotoDerivatives,
  computeMatchStats,
  MAX_QUERY_PHOTOS
} = require('../facematch');
const { backfillUnindexedPetPhotos } = require('../petmatch');
const { publicUpdate } = require('../privacy');
const gh = require('../github');
const { sendReport } = require('../report');
const { createReportAdmission } = require('../report-admission');

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

// Turn SendGrid's raw response into an actionable sentence in Spanish.
function emailVerdict(email) {
  if (!email.sendgrid_key_present) {
    return 'SENDGRID_API_KEY no está definida en este entorno de Vercel. Agrégala en Settings → Environment Variables (Production) y vuelve a desplegar.';
  }
  if (!email.sendgrid_key_looks_valid) {
    return `La clave no empieza por "SG." (empieza por "${email.sendgrid_key_prefix}"), así que no parece una API key de SendGrid. Genera una en SendGrid → Settings → API Keys con permiso "Mail Send".`;
  }
  const t = email.test || {};
  if (t.ok) return 'Correo enviado correctamente. Si no llega, revisa spam y la Activity Feed de SendGrid.';
  const err = String(t.error || '');
  if (t.status === 401) {
    return 'SendGrid rechazó la clave (401). Genera una nueva API key con permiso "Mail Send" y actualízala en Vercel.';
  }
  if (t.status === 403) {
    if (/Sender Identity|from address/i.test(err)) {
      return `SendGrid rechaza el remitente ${email.from} (403): no está verificado. Verifícalo en SendGrid → Settings → Sender Authentication (Single Sender o dominio). Alternativa inmediata: define EMAIL_FROM en Vercel con un remitente ya verificado.`;
    }
    return `SendGrid devolvió 403: la clave existe pero no tiene permiso "Mail Send", o el remitente ${email.from} no está verificado.`;
  }
  if (t.error && /fetch/i.test(err)) {
    return 'El entorno no pudo hacer la petición HTTP a SendGrid (fetch falló). Revisa la versión de Node en Vercel.';
  }
  return `SendGrid respondió ${t.status || 'sin estado'}: ${err.slice(0, 300)}`;
}

function apiRoutes(store, matcher, petStore, petMatcher) {
  const router = express.Router();
  router.use(express.json({ limit: '16mb' }));

  const admission = createReportAdmission({ store, matcher });

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
          latest_update: publicUpdate(await store.getLatestUpdate(p.id))
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
        updates: (await store.getUpdates(person.id)).map(publicUpdate)
      });
    })
  );

  // POST /api/updates — report status by name (creates the person if new)
  // { name, status, message?, location?, reporter?, source?, source_url?, external_id?,
  //   photo?: { base64, content_type } }
  // The photo is used ONLY for face matching; it is never displayed or shared.
  // - source: one of 'web'|'whatsapp'|'api'|'aggregator'; defaults to 'api' if
  //   omitted or not one of those values (e.g. an aggregator identifying itself).
  // - source_url: public link backing this report — the news story saying the
  //   person turned up. Rendered as a clickable link on the person's page, so
  //   only http(s) is accepted; anything else is dropped with a log and the
  //   report still goes through. The rule lives in the shared admission
  //   service, not here (src/report-admission.js).
  // - external_id: the caller's own id for this update. When present, a repeat
  //   POST with the same external_id updates this same update idempotently
  //   instead of creating a duplicate — safe to retry or re-sync from upstream.
  //   source_url is part of that upsert, so a re-push corrects a wrong link.
  router.post(
    '/updates',
    requireKey,
    wrap(async (req, res) => {
      const { name, status, message, location, reporter, contact } = req.body || {};
      if (!name || !String(name).trim()) return res.status(400).json({ error: 'Falta name' });
      if (!STATUSES.includes(status)) {
        return res.status(400).json({ error: `status debe ser uno de: ${STATUSES.join(', ')}` });
      }
      const externalId =
        req.body.external_id != null && String(req.body.external_id).trim()
          ? String(req.body.external_id).trim()
          : undefined;
      const photo = decodePhoto(req.body.photo);

      // Thin adapter: the shared report-admission service owns the whole domain
      // sequence (owner resolution after external_id upsert, photo indexing,
      // subscriber notification, and — LAST, once the report is durable — the
      // duplicate check). This route only decodes JSON in and shapes JSON out.
      const result = await admission.admitReport({
        name,
        status,
        message,
        location,
        lat: typeof req.body.lat === 'number' ? req.body.lat : parseFloat(req.body.lat),
        lng: typeof req.body.lng === 'number' ? req.body.lng : parseFloat(req.body.lng),
        source: req.body.source,
        // Straight from the body, unvalidated on purpose: the service owns the
        // http(s)-only rule, so it can't end up meaning one thing here and
        // another one on the next entry point that starts accepting a link.
        sourceUrl: req.body.source_url,
        reporter,
        contact,
        externalId,
        photos: photo ? [photo] : [],
        checkDuplicates: true
      });
      // Unreachable today — the checks above already cover exactly what the
      // service validates — but the service is the single source of truth for
      // its own contract: a caller that stops prevalidating, or a validation
      // rule that changes only on one side, must get a 400 with `errors` here
      // instead of a TypeError on `result.person`.
      if (!result.ok) {
        return res.status(400).json({ error: result.errors.join(' ') });
      }

      res.status(201).json({
        person_id: result.person.id,
        person_created: result.personCreated,
        update: result.update,
        photo_stored: !!photo,
        // What the caller needs to reconcile on their side. `person_created:
        // false` already meant "appended to an existing record"; this spells
        // that out and adds the face-based collisions a name never sees.
        duplicate: {
          merged_into_existing_person: result.mergedIntoExisting,
          candidates: result.candidates.map((c) => ({
            person_id: c.person.id,
            full_name: c.person.full_name,
            reason: c.reason,
            // Only a FACE match carries a comparable percentage. The name
            // signal is a fuzzy string score on a different scale entirely, and
            // shipping both under one key invites `if (similarity >= 80) merge`
            // — which would collapse "Juan Carlos Pérez" and "Juan Camilo
            // Pérez", two different missing people, into one record.
            similarity: c.reason === 'face' ? c.similarity : null,
            name_score: c.reason === 'name' ? c.similarity / 100 : null,
            url: `${env.BASE_URL}/person/${c.person.id}`
          })),
          warning: result.warning
        }
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
          await sendVerificationEmail(person, sub);
        }
        res.status(201).json({ ok: true, pending_verification: needsVerification, photos_stored: photosStored });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    })
  );

  // Test records created while diagnosing the email pipeline. The purge below
  // can only ever touch these exact names, so it needs no secret to be safe.
  const TEST_RECORD_NAMES = [
    'prueba entrega correo',
    'verificacion final',
    'cadena completa',
    'prueba suscribir',
    'zona horaria',
    'conteo prueba'
  ];

  // POST /api/maintenance/purge-test-data — remove only the seeded test rows,
  // y ahora también sus firmas faciales: un registro de prueba no tiene por qué
  // dejar un dato biométrico en la colección después de que su ficha se fue.
  //
  // Sigue siendo segura sin llave, y el radio no cambió: solo puede tocar a
  // quien tenga uno de los nombres de la lista fija de arriba, igual que antes.
  // Y cuando no hay nada que purgar no gasta ni una llamada a Rekognition,
  // porque el retiro va después del borrado y ese bucle no entra.
  router.post(
    '/maintenance/purge-test-data',
    wrap(async (req, res) => {
      const { normalize } = require('../names');
      const removed = [];
      const firmas = { total: 0, deleted: 0, unconfirmed: [] };
      for (const name of TEST_RECORD_NAMES) {
        for (const p of await store.searchPeople(name, { limit: 20, minScore: 0.6 })) {
          const norm = normalize(p.full_name);
          // Only exact matches or the same name plus a trailing id.
          if (!TEST_RECORD_NAMES.some((t) => norm === t || norm.startsWith(t + ' '))) continue;
          // Mismo orden que el DELETE del ARCO, y por la misma razón: los ids
          // antes del borrado porque la cascada se los lleva, y las firmas
          // después, cuando ya no hay ficha que dejar huérfana.
          const faceIds = await store.faceIdsForPerson(p.id);
          const deleted = await store.deletePerson(p.id);
          if (!deleted) continue;
          removed.push({ id: p.id, name: p.full_name });
          const faces = await forgetPersonFaces(matcher, faceIds, p.id);
          firmas.total += faces.total;
          firmas.deleted += faces.deleted;
          firmas.unconfirmed.push(...faces.unconfirmed);
        }
      }
      res.json({ ok: true, removed_count: removed.length, removed, faces: firmas });
    })
  );

  // DELETE /api/people/:id — honours the deletion requests promised in the
  // privacy policy. Requires API_KEY; disabled entirely when it is unset.
  //
  // Borra las dos copias del rastro: la fila (y en cascada sus reportes,
  // suscripciones y fotos) y las firmas faciales en la colección de
  // Rekognition, que no viven en la base y por tanto la cascada no toca.
  router.delete(
    '/people/:id',
    wrap(async (req, res) => {
      if (!env.API_KEY) {
        return res
          .status(503)
          .json({ error: 'Borrado deshabilitado: define API_KEY para habilitarlo.' });
      }
      if ((req.get('authorization') || '') !== `Bearer ${env.API_KEY}`) {
        return res.status(401).json({ error: 'API key inválida o ausente' });
      }
      // Los ids se leen ANTES del borrado: la cascada se lleva las filas de
      // `photos` y con ellas la única forma de saber qué firmas retirar.
      const faceIds = await store.faceIdsForPerson(req.params.id);
      const deleted = await store.deletePerson(req.params.id);
      if (!deleted) return res.status(404).json({ error: 'Persona no encontrada' });
      // Y las firmas DESPUÉS, ya sabiendo que la ficha se fue. Al revés —como
      // abrió este PR— si la base fallaba en el medio quedaban las firmas
      // borradas y la ficha viva: una persona listada como desaparecida y
      // permanentemente invisible para el matcher, porque
      // `backfillUnindexedPhotos` solo recoge fotos con `face_id` nulo y estas
      // lo conservan. De las dos huérfanas posibles esa es la peor, porque le
      // cuesta algo a quien está buscando a un familiar. Nunca lanza, así que
      // un Rekognition caído tampoco deshace el borrado ya hecho.
      const faces = await forgetPersonFaces(matcher, faceIds, deleted.id);
      res.json({
        ok: true,
        deleted: { id: deleted.id, full_name: deleted.full_name },
        // Lo que quedó por retirar. Reintentar el DELETE ya no sirve —la
        // persona no existe y sus ids se fueron con ella—, así que esta
        // respuesta y el log son el único rastro para limpiarlo a mano.
        faces
      });
    })
  );

  // POST/GET /api/reindex — index photos stored while matching was down and
  // notify anyone whose search now matches. Safe to run repeatedly.
  // Triggers AWS Rekognition + subscriber notifications, so it requires the API key.
  //
  // Also brings already-stored report photos up to date: the detection geometry
  // the public overlay draws, and the face thumbnail the listing loads.
  router.all(
    '/reindex',
    requireKey,
    wrap(async (req, res) => {
      const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 500);
      const indexed = await backfillUnindexedPhotos(store, matcher, limit);
      const derivatives = await backfillPhotoDerivatives(store, matcher, limit);
      const pets = petStore ? await backfillUnindexedPetPhotos(petStore, petMatcher, limit) : null;
      res.json({ ...indexed, derivatives, pets });
    })
  );

  // GET /api/match-stats — recomputa el cruce facial histórico contra la
  // colección y devuelve SOLO cifras agregadas (parte 1 de #116). No escribe
  // nada y no notifica a nadie.
  //
  // Va detrás de la API key aunque sea una lectura. La regla de "las lecturas
  // quedan abiertas" existe porque la información de emergencia quiere ser
  // encontrada — y esto no es eso: son cifras de operación, y cada llamada
  // dispara decenas de búsquedas en Rekognition (cuestan plata y tienen tope
  // por segundo), así que dejarla abierta regala un botón de gasto.
  router.get(
    '/match-stats',
    requireKey,
    wrap(async (req, res) => {
      const stats = await computeMatchStats(store, matcher);
      if (!stats) {
        return res
          .status(503)
          .json({ error: `El matcher facial no está disponible: ${matcher.status}` });
      }
      res.json(stats);
    })
  );

  // ALL /api/report/send — arma y manda el reporte operativo recurrente
  // (#116, PR 2). Lo dispara el cron de Vercel 3×/día y, a mano, un operador
  // con la API key (el primer envío real lo dispara un humano apenas mergee).
  //
  // A diferencia del resto de esta ruta, acá NO aplica "las lecturas quedan
  // abiertas": esto tiene efecto de lado (manda correos vía SendGrid, que
  // cuesta y tiene cuota) y expone cifras de operación, así que falla CERRADO
  // — a diferencia de requireKey, que si no hay API_KEY configurada deja
  // pasar. Acepta la API key existente (Authorization: Bearer <API_KEY>) o el
  // secreto que Vercel Cron manda solo (Authorization: Bearer <CRON_SECRET>,
  // ver https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs)
  // — nunca ambos sin configurar.
  function requireKeyOrCron(req, res, next) {
    const auth = req.get('authorization') || '';
    if (env.API_KEY && auth === `Bearer ${env.API_KEY}`) return next();
    const cronSecret = (process.env.CRON_SECRET || '').trim();
    if (cronSecret && auth === `Bearer ${cronSecret}`) return next();
    res.status(401).json({ error: 'Credencial inválida o ausente (API key o CRON_SECRET)' });
  }
  router.all(
    '/report/send',
    requireKeyOrCron,
    wrap(async (req, res) => {
      const result = await sendReport(store, matcher);
      res.status(result.ok ? 200 : 502).json(result);
    })
  );

  // GET /api/diag/sendgrid — ask SendGrid about deliverability for an address:
  // suppressions (bounce/block/spam/invalid), verified senders, and whether the
  // sending domain is authenticated (SPF/DKIM). A 202 from the send API only
  // means "accepted"; these are the reasons mail still never lands.
  router.get(
    '/diag/sendgrid',
    wrap(async (req, res) => {
      const key = (process.env.SENDGRID_API_KEY || env.SENDGRID_API_KEY || '').trim();
      if (!key) return res.status(400).json({ error: 'SENDGRID_API_KEY no configurada' });
      const address = String(req.query.email || '').trim();

      const get = async (path) => {
        try {
          const r = await fetch(`https://api.sendgrid.com${path}`, {
            headers: { Authorization: `Bearer ${key}` }
          });
          const text = await r.text();
          let body;
          try {
            body = JSON.parse(text);
          } catch {
            body = text.slice(0, 300);
          }
          return { status: r.status, body };
        } catch (e) {
          return { error: e.message };
        }
      };

      const [bounces, blocks, spam, invalid, senders, domains] = await Promise.all([
        address ? get(`/v3/suppression/bounces/${encodeURIComponent(address)}`) : { skipped: true },
        address ? get(`/v3/suppression/blocks/${encodeURIComponent(address)}`) : { skipped: true },
        address ? get(`/v3/suppression/spam_reports/${encodeURIComponent(address)}`) : { skipped: true },
        address ? get(`/v3/suppression/invalid_emails/${encodeURIComponent(address)}`) : { skipped: true },
        get('/v3/verified_senders'),
        get('/v3/whitelabel/domains')
      ]);

      const domainList = Array.isArray(domains.body) ? domains.body : [];
      const fromDomain = env.EMAIL_FROM.split('@')[1];
      const matching = domainList.find((d) => d.domain === fromDomain);

      res.json({
        from: env.EMAIL_FROM,
        checked_address: address || '(pasa ?email= para revisar supresiones)',
        suppressions: { bounces, blocks, spam, invalid },
        verified_senders_status: senders.status,
        verified_senders: Array.isArray(senders.body?.results)
          ? senders.body.results.map((v) => ({ email: v.from_email, verified: v.verified }))
          : senders.body,
        domain_authentication:
          domains.status !== 200
            ? `No se pudo verificar: la API key solo tiene permiso "Mail Send" (SendGrid respondió ${domains.status}). Revísalo en SendGrid → Settings → Sender Authentication.`
            : matching
              ? { domain: matching.domain, valid: matching.valid }
              : `El dominio ${fromDomain} no aparece autenticado en SendGrid. Sin SPF/DKIM propios, Gmail y Outlook suelen mandar el correo a spam — sobre todo si el destinatario es del mismo dominio que el remitente.`
      });
    })
  );

  // GET /api/diag — configuration and live self-test. Never exposes secrets,
  // never sends email (a GET must not have side effects — see POST /api/diag/test-email).
  router.get(
    '/diag',
    wrap(async (req, res) => {
      if (typeof matcher.ensureReady === 'function') {
        await matcher.ensureReady();
      }
      // Read the key live: config captured at module load can be stale.
      const liveKey = (process.env.SENDGRID_API_KEY || env.SENDGRID_API_KEY || '').trim();
      const out = {
        base_url: env.BASE_URL,
        database: {
          driver: process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.STORAGE_URL ? 'postgres' : 'sqlite (efímero)',
          ok: false
        },
        runtime: {
          node: process.version,
          vercel_env: process.env.VERCEL_ENV || '(local)',
          fetch_available: typeof fetch === 'function'
        },
        email: {
          sendgrid_key_present: !!liveKey,
          // Fingerprint only — never the secret itself.
          sendgrid_key_len: liveKey.length,
          sendgrid_key_prefix: liveKey.slice(0, 3),
          sendgrid_key_looks_valid: /^SG\./.test(liveKey),
          raw_key_had_whitespace:
            !!process.env.SENDGRID_API_KEY &&
            process.env.SENDGRID_API_KEY !== process.env.SENDGRID_API_KEY.trim(),
          from: env.EMAIL_FROM,
          // Presence only, never the address. Three things route through this
          // mailbox — the rescuer's aviso, "report this on Colombia Te Busca
          // too", and every relayed notification (see `notifications` below) —
          // and all of them fail QUIETLY without it: the visitor still gets a
          // success page, the report is still saved, and nobody is told the
          // relay went nowhere. From outside there is no other way to notice.
          aviso_email_present: !!avisoEmail()
        },
        // Los avisos que van a un TERCERO (actualización a quien sigue a una
        // persona, coincidencia facial con un rescatista). En modo relevo
        // ninguno se entrega: todos aterrizan en AVISO_EMAIL para que una
        // persona los verifique y los enrute. Se expone acá para poder ver
        // desde afuera en qué modo está, sin leer los logs ni el código.
        notifications: {
          mode: notifyMode(),
          relay_mailbox_present: !!avisoEmail(),
          // Relevo activo y sin buzón: no sale nada, para nadie, y el único
          // rastro es una línea "[notify:relevo] PERDIDO" en los logs.
          relay_without_mailbox: relayEnabled() && !avisoEmail()
        },
        faces: {
          aws_key_present: !!process.env.AWS_ACCESS_KEY_ID,
          aws_region: process.env.AWS_REGION || '(sin definir → us-east-1)',
          matcher_enabled: !!matcher.enabled,
          status: matcher.status || 'desconocido'
        },
        pet_matching: {
          api_url_present: !!process.env.PET_MATCH_API_URL,
          enabled: !!(petMatcher && petMatcher.enabled),
          status: (petMatcher && petMatcher.status) || 'sin inicializar'
        },
        // Same reasoning as aviso_email_present: without a token /ideas and
        // /bug keep working but quietly fall back to email, so the issue
        // tracker just stays empty and looks like nobody wrote in.
        github: {
          token_present: gh.configured(),
          repo: gh.repo()
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

      res.json(out);
    })
  );

  // POST /api/diag/test-email — sends a real test email and reports the result.
  // A side effect that spends SendGrid quota belongs behind the API key, not on a GET.
  // { email }
  router.post(
    '/diag/test-email',
    requireKey,
    wrap(async (req, res) => {
      const email = req.body && req.body.email;
      if (!email || !String(email).trim()) {
        return res.status(400).json({ error: 'Falta email' });
      }
      // Same key fingerprinting as GET /api/diag so emailVerdict can produce
      // its actionable sentence on the send path too (never the secret itself).
      const liveKey = (process.env.SENDGRID_API_KEY || env.SENDGRID_API_KEY || '').trim();
      const info = {
        sendgrid_key_present: !!liveKey,
        sendgrid_key_prefix: liveKey.slice(0, 3),
        sendgrid_key_looks_valid: /^SG\./.test(liveKey),
        from: env.EMAIL_FROM
      };
      const { sendEmail } = require('../notify');
      info.test = await sendEmail(
        String(email).trim(),
        'Prueba de configuración — encontrados.co',
        'Si recibes este correo, el envío desde encontrados.co funciona correctamente.'
      );
      info.veredicto = emailVerdict(info);
      res.json({ email: info });
    })
  );

  return router;
}

module.exports = { apiRoutes };
