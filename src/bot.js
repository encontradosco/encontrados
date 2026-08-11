// Conversation engine for WhatsApp.
// Understands Spanish (primary) and English commands; always replies in Spanish.
const { normalize } = require('./names');
const { notifySubscribers, STATUS_LABEL } = require('./notify');
const { processPhoto, MAX_QUERY_PHOTOS } = require('./facematch');
const { nullMatcher } = require('./faces');

const HELP = [
  '🆘 *aqui.online* — información de personas en emergencias.',
  '',
  'Comandos:',
  '• BUSCAR <nombre> — consultar el estado de una persona',
  '• BIEN <nombre>: <nota> @ <lugar> — reportar que está a salvo',
  '• HERIDO <nombre>: <nota> — reportar que está herido(a)',
  '• DESAPARECIDO <nombre>: <nota> — reportar desaparición',
  '• SUSCRIBIR <nombre> — recibir avisos a este número',
  '• BAJA <nombre> — dejar de recibir avisos (BAJA TODO para cancelar todos)',
  '',
  'Ejemplo: BIEN Juan Pérez: hablé con él @ albergue San José',
  '',
  '📷 Puedes adjuntar una foto poniendo el comando como leyenda de la imagen.',
  '🔒 Gracias a nuestra IA, reconocemos a esta persona por su firma facial y te avisamos si hay coincidencia — tus fotos nunca se comparten ni se muestran a nadie.'
].join('\n');

const COMMANDS = [
  { intent: 'help', words: ['ayuda', 'help', 'hola', 'hi', 'hello', 'start', 'menu', 'inicio'] },
  { intent: 'find', words: ['buscar', 'busca', 'estado', 'status', 'find', 'search', 'info', 'consultar'] },
  { intent: 'report', status: 'safe', words: ['bien', 'salvo', 'asalvo', 'safe', 'ok'] },
  { intent: 'report', status: 'injured', words: ['herido', 'herida', 'injured', 'hurt'] },
  { intent: 'report', status: 'missing', words: ['desaparecido', 'desaparecida', 'perdido', 'perdida', 'missing', 'lost'] },
  { intent: 'report', status: 'deceased', words: ['fallecido', 'fallecida', 'deceased'] },
  { intent: 'subscribe', words: ['suscribir', 'suscribirme', 'seguir', 'subscribe', 'follow', 'avisar', 'avisame'] },
  { intent: 'unsubscribe', words: ['baja', 'stop', 'unsubscribe', 'cancelar'] }
];

function parseMessage(text) {
  const raw = String(text || '').trim();
  if (!raw) return { intent: 'help' };
  const firstWord = normalize(raw.split(/\s+/)[0]);
  const rest = raw.split(/\s+/).slice(1).join(' ').trim();
  for (const cmd of COMMANDS) {
    if (cmd.words.includes(firstWord)) {
      const [name, detail] = rest.split(/\s*[:\-–—]\s+/, 2);
      const [note, location] = (detail || '').split(/\s*@\s*/, 2);
      return {
        intent: cmd.intent,
        status: cmd.status,
        name: (name || '').trim(),
        note: (note || '').trim(),
        location: (location || '').trim()
      };
    }
  }
  // No keyword: treat the whole message as a lookup by name.
  return { intent: 'find', name: raw, note: '', location: '' };
}

function timeAgo(iso) {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `hace ${hours} h`;
  return `hace ${Math.round(hours / 24)} días`;
}

async function personSummary(store, person) {
  const latest = await store.getLatestUpdate(person.id);
  if (!latest) return `• *${person.full_name}* — sin reportes todavía`;
  const parts = [
    `• *${person.full_name}*: ${STATUS_LABEL[latest.status]} (${timeAgo(latest.created_at)})`
  ];
  if (latest.message) parts.push(`  Nota: ${latest.message}`);
  if (latest.location) parts.push(`  Ubicación: ${latest.location}`);
  return parts.join('\n');
}

// channel: 'whatsapp'; from: the sender's phone number (also the subscription
// address for that channel). photo: optional { bytes, contentType } attached to
// the message. Returns the reply text.
async function handleInbound(store, { channel, from, text, photo, matcher = nullMatcher }) {
  const parsed = parseMessage(text);

  if (parsed.intent === 'help' || (parsed.intent !== 'help' && !parsed.name)) {
    return HELP;
  }

  if (parsed.intent === 'find') {
    const matches = await store.searchPeople(parsed.name, { limit: 3 });
    if (!matches.length) {
      return [
        `No encontré reportes sobre "${parsed.name}".`,
        `Escribe SUSCRIBIR ${parsed.name} y te avisaré a este número cuando haya noticias.`
      ].join('\n');
    }
    const lines = await Promise.all(matches.map((m) => personSummary(store, m)));
    lines.push('', 'Para recibir avisos: SUSCRIBIR <nombre>');
    return lines.join('\n');
  }

  if (parsed.intent === 'report') {
    const { person, created } = await store.findOrCreatePerson(parsed.name);
    const update = await store.addUpdate(person.id, {
      status: parsed.status,
      message: parsed.note || null,
      location: parsed.location || null,
      source: channel,
      reporter: from
    });
    await notifySubscribers(store, person, update, { skipAddress: from });
    if (photo) {
      await processPhoto(store, matcher, {
        personId: person.id,
        kind: 'report',
        updateId: update.id,
        bytes: photo.bytes,
        contentType: photo.contentType
      });
    }
    return [
      `✅ Registrado: *${person.full_name}* — ${STATUS_LABEL[parsed.status]}.`,
      created ? null : 'Se agregó a los reportes existentes de esta persona.',
      photo ? '📷 Foto recibida. Nunca se compartirá: solo se usa para reconocimiento facial.' : null,
      `Gracias por ayudar. Para seguir sus novedades: SUSCRIBIR ${person.full_name}`
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (parsed.intent === 'subscribe') {
    const { person } = await store.findOrCreatePerson(parsed.name);
    const { sub } = await store.subscribe(person.id, channel, from);
    let photoLine = null;
    if (photo && sub) {
      const count = await store.countQueryPhotos(sub.id);
      if (count >= MAX_QUERY_PHOTOS) {
        photoLine = `Ya tienes ${MAX_QUERY_PHOTOS} fotos para esta búsqueda; no agregué más.`;
      } else {
        await processPhoto(store, matcher, {
          personId: person.id,
          kind: 'query',
          subscriptionId: sub.id,
          bytes: photo.bytes,
          contentType: photo.contentType
        });
        photoLine =
          '📷 Foto guardada para reconocimiento facial (máx. 3). Nunca se compartirá ni se mostrará a nadie; si hay coincidencia, te aviso sin mostrar fotos.';
      }
    }
    const latest = await store.getLatestUpdate(person.id);
    return [
      `🔔 Listo. Te avisaré a este número cuando haya novedades de *${person.full_name}*.`,
      photoLine,
      latest ? await personSummary(store, person) : 'Aún no hay reportes de esta persona.',
      'Para cancelar: BAJA ' + person.full_name
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (parsed.intent === 'unsubscribe') {
    if (normalize(parsed.name) === 'todo' || normalize(parsed.name) === 'all') {
      const n = await store.unsubscribeAll(channel, from);
      return n
        ? `Listo, cancelé tus ${n} suscripciones.`
        : 'No tenías suscripciones activas.';
    }
    const matches = await store.searchPeople(parsed.name, { limit: 1 });
    if (!matches.length) return `No encontré a "${parsed.name}" entre tus suscripciones.`;
    const n = await store.unsubscribe(matches[0].id, channel, from);
    return n
      ? `Listo, ya no recibirás avisos sobre *${matches[0].full_name}*.`
      : `No estabas suscrito(a) a ${matches[0].full_name}.`;
  }

  return HELP;
}

module.exports = { handleInbound, parseMessage, HELP };
