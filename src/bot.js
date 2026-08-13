// Conversation engine for WhatsApp.
// Understands Spanish (primary) and English commands; always replies in Spanish.
const { normalize } = require('./names');
const { relayEnabled, STATUS_LABEL } = require('./notify');
const {
  processPhoto,
  resolveRescueAnswer,
  MAX_QUERY_PHOTOS
} = require('./facematch');
const { nullMatcher } = require('./faces');
const { createReportAdmission } = require('./report-admission');

const HELP = [
  '🆘 *encontrados.co* — información de personas en emergencias.',
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
  '🔒 Las fotos NUNCA se comparten ni se muestran a nadie: solo se usan para reconocimiento facial y avisarte si hay coincidencia.'
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

// Respuesta a la plantilla `confirmacion_rescatista_encontrados` (paso 1 de la
// entrega en dos pasos, en src/facematch.js). Esa plantilla pide dos respuestas
// concretas, escritas: **SÍ** o **REPORTE**.
//
// Se exigen EXACTAS, y no como prefijo de una frase. Mirar solo la primera
// palabra convertía "Claro que no es ella" y "Si la veo te aviso" en
// confirmaciones — dos frases que dicen justo lo contrario— y encima se tragaba
// el mensaje: la búsqueda que la persona quería hacer nunca corría. Un mensaje
// que no es una de las dos respuestas no se consume: sigue de largo y se
// procesa como cualquier otro.
//
// `normalize` ya quitó tildes, mayúsculas y puntuación, así que "SÍ", "Sí." y
// "si" son la misma palabra, y "Sí, está conmigo" no lo es.
const ANSWERS = { si: 'si', reporte: 'reporte' };

function rescueAnswer(text) {
  return ANSWERS[normalize(text)] || null;
}

// Lo que se le contesta a quien acaba de responder. Nunca lleva el contacto de
// una familia: por WhatsApp eso no sale, y prometerlo sería mentir dos veces
// —una sobre lo que va a llegar y otra sobre lo que tenemos.
function rescueAnswerReply(result) {
  if (result.answer === 'reporte') {
    return [
      '✅ Gracias por aclararlo.',
      `Entonces quedas anotado como quien busca a *${result.person}*, no como quien la tiene consigo.`,
      'Te avisamos si hay novedades. Para dejar de recibir mensajes, responde BAJA TODO.'
    ].join('\n');
  }
  if (result.sent) {
    return [
      '✅ Gracias por confirmar.',
      `Te acabamos de enviar el enlace de la ficha de *${result.person}* en el registro donde su familia la está buscando.`,
      'Márcala como localizada ahí: es lo que hace que su familia se entere. Nosotros no tenemos su contacto, ellos sí.'
    ].join('\n');
  }
  return [
    '✅ Gracias por confirmar.',
    `Registramos que *${result.person}* está contigo.`,
    relayEnabled()
      ? 'Una persona del equipo revisa cada caso y se encarga de que el aviso le llegue a quien la busca. Puede tomar un momento.'
      : 'Una persona del equipo se encarga de que el aviso le llegue a quien la busca.',
    'Si este mensaje te llegó por error, responde BAJA TODO y no te volvemos a escribir.'
  ].join('\n');
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
  // Antes que cualquier comando: SÍ y REPORTE solo significan algo si a este
  // número le preguntamos algo y sigue esperando respuesta. Si no hay nada
  // pendiente, vuelven a ser palabras cualesquiera y el mensaje se procesa como
  // siempre — nada se consume por parecerse a una confirmación.
  if (channel === 'whatsapp') {
    const answer = rescueAnswer(text);
    if (answer) {
      const resolved = await resolveRescueAnswer(store, from, { answer });
      if (resolved) return rescueAnswerReply(resolved);
    }
  }

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
    // Thin adapter over the shared report-admission flow: WhatsApp parsing and
    // reply text stay here, the domain sequence (person, update, owner
    // resolution, duplicate check, photo indexing, notification) lives in the
    // service so web, API and WhatsApp behave the same.
    const admission = createReportAdmission({ store, matcher });
    const result = await admission.admitReport({
      name: parsed.name,
      status: parsed.status,
      message: parsed.note || null,
      location: parsed.location || null,
      source: channel,
      reporter: from,
      photos: photo ? [photo] : [],
      skipAddresses: [from]
    });
    // Unreachable today — parseMessage only reaches intent 'report' with a
    // name (checked above) and a status straight from COMMANDS, always one of
    // STATUSES — but the WhatsApp reply text assumes `result.person` exists,
    // so a validation rule that ever diverges must get a message back instead
    // of throwing mid-conversation.
    if (!result.ok) return HELP;
    return [
      `✅ Registrado: *${result.person.full_name}* — ${STATUS_LABEL[parsed.status]}.`,
      result.personCreated ? null : 'Se agregó a los reportes existentes de esta persona.',
      photo ? '📷 Foto recibida. Nunca se compartirá: solo se usa para reconocimiento facial.' : null,
      `Gracias por ayudar. Para seguir sus novedades: SUSCRIBIR ${result.person.full_name}`
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

module.exports = { handleInbound, parseMessage, rescueAnswer, HELP };
