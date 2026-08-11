// Outbound notifications: email (SendGrid) and WhatsApp (Meta Cloud API).
// All fire-and-forget with logging — a failed notification must never block a report.
const env = require('./env');

const STATUS_LABEL = {
  safe: 'A SALVO',
  injured: 'HERIDO(A)',
  missing: 'DESAPARECIDO(A)',
  deceased: 'FALLECIDO(A)',
  unknown: 'SIN CONFIRMAR'
};

function updateText(person, update) {
  const lines = [
    `${person.full_name}: ${STATUS_LABEL[update.status] || update.status}`,
    update.message ? `Nota: ${update.message}` : null,
    update.location ? `Ubicación: ${update.location}` : null,
    `${env.BASE_URL}/person/${person.id}`
  ];
  return lines.filter(Boolean).join('\n');
}

// ------------------------------------------------------------- modo de envío
//
// Entregarle el contacto de una familia a un desconocido que dice haber
// rescatado a alguien es un vector de extorsión, y la app lo venía haciendo
// sola: el aviso salía derecho al tercero, sin nadie en el circuito. En modo
// RELEVO —el modo por omisión— ningún aviso a un tercero se envía: todos se
// centralizan en el buzón del operador (AVISO_EMAIL) con el contexto suficiente
// para que una persona verifique quién es el destinatario y lo enrute a mano.
//
// NOTIFY_MODE=direct devuelve el comportamiento anterior. Se lee EN VIVO de
// process.env, nunca del snapshot de env.js, para que cambiar de modo sea una
// variable y no un despliegue de código. Cualquier valor distinto de "direct"
// —incluida una errata— significa relevo: este interruptor falla cerrado.
const DIRECT = 'direct';
const RELAY = 'relay';

function notifyMode() {
  const raw = (process.env.NOTIFY_MODE || '').trim().toLowerCase();
  if (!raw || raw === RELAY) return RELAY;
  if (raw === DIRECT) return DIRECT;
  console.warn(`[notify:relevo] NOTIFY_MODE="${raw}" no se reconoce — se asume "relay" (nada sale a terceros).`);
  return RELAY;
}

function relayEnabled() {
  return notifyMode() === RELAY;
}

// El buzón de operación. Live desde process.env por la misma razón, y para que
// una prueba pueda borrarlo y ejercitar el camino "sin configurar".
function avisoEmail() {
  return (process.env.AVISO_EMAIL || env.AVISO_EMAIL || '').trim();
}

// Prefijo estable y grepeable, tanto en el buzón como en los logs.
const RELAY_SUBJECT_PREFIX = '[RETENIDO]';
const CHANNEL_LABEL = { email: 'correo', whatsapp: 'WhatsApp' };

// Le manda al operador un aviso que NO se entregó, con todo lo que hace falta
// para enrutarlo sin abrir la base de datos. Nunca lanza: un fallo acá no puede
// tumbar el reporte ni la coincidencia que lo originó.
async function relayToOperators({ reason, channel, address, subject, text, person, details = [] }) {
  const to = avisoEmail();
  const ficha = person ? `${env.BASE_URL}/person/${person.id}` : null;
  const trace =
    `motivo="${reason}" canal=${channel} destino=${address} ` +
    `persona=${person ? person.id : '?'} ficha=${ficha || '-'}`;

  if (!to) {
    // El relevo está activo y no hay a dónde relevar. Caer a envío directo
    // reabriría en silencio justo el riesgo que el relevo existe para cerrar,
    // y encima cuando la configuración ya está rota — así que no sale nada.
    // Este log es la ÚNICA copia que queda del aviso, por eso lleva el texto
    // completo: perderlo es peor que tenerlo en el log del operador.
    console.error(`[notify:relevo] PERDIDO — relevo activo y AVISO_EMAIL sin configurar. ${trace}\n${text}`);
    return { ok: false, relayed: false, error: 'AVISO_EMAIL no configurada' };
  }

  const body = [
    'Este aviso NO se envió a su destinatario.',
    '',
    'encontrados.co está en modo relevo: los avisos que iban a terceros se',
    'centralizan en este buzón para que una persona verifique a quién se le',
    'está entregando el dato antes de que salga.',
    '',
    `Iba dirigido a: ${address}`,
    `Canal: ${CHANNEL_LABEL[channel] || channel}`,
    `Motivo: ${reason}`,
    person ? `Persona: ${person.full_name}` : null,
    ficha ? `Ficha: ${ficha}` : null,
    ...details,
    '',
    `Asunto original: ${subject}`,
    '--- texto que se iba a enviar ---',
    text,
    '--- fin del texto ---',
    '',
    'Siguiente paso: verificar la identidad del destinatario y, si corresponde,',
    'hacerle llegar el texto de arriba. De aquí no sale nada solo.'
  ]
    .filter((l) => l !== null)
    .join('\n');

  const relaySubject = `${RELAY_SUBJECT_PREFIX} ${reason} — ${person ? person.full_name : 'sin persona'}`;
  const result = await sendEmail(to, relaySubject, body);
  if (!result.ok) {
    console.error(`[notify:relevo] PERDIDO — el relevo a ${to} falló (${result.error || result.status}). ${trace}\n${text}`);
    return { ...result, relayed: false };
  }
  console.log(`[notify:relevo] retenido y relevado a ${to} — ${trace}`);
  return { ...result, relayed: true };
}

// Returns { ok, status, error } and logs loudly — email silence is a bug we
// must be able to diagnose from the Vercel logs alone.
async function sendEmail(to, subject, text) {
  // Read from process.env too so configuration applied after module load
  // (and test doubles) are honoured.
  const apiKey = process.env.SENDGRID_API_KEY || env.SENDGRID_API_KEY;
  const apiBase = process.env.SENDGRID_API_BASE || 'https://api.sendgrid.com';
  if (!apiKey) {
    console.error(`[notify:email] SKIPPED — SENDGRID_API_KEY is not set. to=${to}`);
    return { ok: false, error: 'SENDGRID_API_KEY no configurada' };
  }
  try {
    const res = await fetch(`${apiBase}/v3/mail/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: env.EMAIL_FROM, name: 'encontrados.co' },
        subject,
        content: [{ type: 'text/plain', value: text }],
        // Click tracking rewrites our links through SendGrid's tracking domain.
        // That domain returns 403 here, which silently broke every
        // verification and unsubscribe link. These are transactional emails:
        // the links must point straight at encontrados.co.
        tracking_settings: {
          click_tracking: { enable: false, enable_text: false },
          open_tracking: { enable: false }
        }
      })
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[notify:email] FAILED ${res.status} from=${env.EMAIL_FROM} to=${to} body=${body}`);
      return { ok: false, status: res.status, error: body };
    }
    console.log(`[notify:email] sent to=${to} subject="${subject}"`);
    return { ok: true, status: res.status };
  } catch (e) {
    console.error(`[notify:email] THREW to=${to}`, e);
    return { ok: false, error: e.message };
  }
}

async function sendWhatsApp(to, text) {
  if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
    console.log(`[notify:whatsapp skipped — not configured] to=${to}`);
    return { ok: false, error: 'WhatsApp no configurado' };
  }
  const res = await fetch(
    `https://graph.facebook.com/v20.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text }
      })
    }
  );
  if (!res.ok) {
    const body = await res.text();
    console.error(`[notify:whatsapp] FALLÓ ${res.status} to=${to} :: ${body}`);
    return { ok: false, status: res.status, error: body.slice(0, 500) };
  }
  return { ok: true, status: res.status };
}

function unsubscribeLink(sub) {
  return `${env.BASE_URL}/unsubscribe?token=${sub.verify_token}`;
}

// NO se releva, a propósito. Este correo va al dueño de la dirección que
// acaba de pedir el aviso, confirmando lo que esa misma persona pidió: no hay
// un tercero a quien proteger y no se entrega ningún dato de nadie más.
// Relevarlo no quitaría ningún riesgo y rompería el alta de suscripciones —
// sin doble opt-in nadie queda verificado y, en consecuencia, tampoco habría
// después ningún aviso que relevar.
async function sendVerificationEmail(person, sub) {
  const link = `${env.BASE_URL}/verify?token=${sub.verify_token}`;
  return sendEmail(
    sub.address,
    `Confirma tu suscripción a novedades de ${person.full_name} — encontrados.co`,
    [
      `Pediste recibir avisos cuando haya novedades de ${person.full_name} en encontrados.co.`,
      '',
      `Confirma tu correo abriendo este enlace: ${link}`,
      '',
      'Si no fuiste tú, ignora este mensaje y no recibirás nada.'
    ].join('\n')
  );
}

// Notify all VERIFIED subscribers of a person about a new update.
// skipAddress: don't echo the update back to whoever reported it.
// Every alert carries that subscriber's personal unsubscribe link.
//
// En modo relevo cada aviso se convierte en un correo al operador — uno por
// destinatario previsto, porque cada uno es una decisión distinta de a quién
// se le entrega qué.
async function notifySubscribers(store, person, update, { skipAddress } = {}) {
  const subs = await store.getSubscriptions(person.id);
  const baseText = `🔔 Actualización en encontrados.co:\n${updateText(person, update)}`;
  const subject = `Actualización sobre ${person.full_name} — encontrados.co`;
  const relay = relayEnabled();
  const jobs = subs
    .filter((s) => s.verified && !(skipAddress && s.address === skipAddress))
    .map((s) => {
      if (s.channel !== 'email' && s.channel !== 'whatsapp') return Promise.resolve(false);
      const text = `${baseText}\n\nPara dejar de recibir estos avisos: ${unsubscribeLink(s)}`;
      if (relay) {
        return relayToOperators({
          reason: 'Actualización de estado para quien sigue a esta persona',
          channel: s.channel,
          address: s.address,
          subject,
          text,
          person
        });
      }
      if (s.channel === 'email') return sendEmail(s.address, subject, text);
      return sendWhatsApp(s.address, text);
    });
  const results = await Promise.allSettled(jobs);
  let sent = 0;
  for (const r of results) {
    if (r.status === 'rejected') console.error('[notify] failed:', r.reason);
    else if (r.value && r.value.ok) sent++;
  }
  console.log(
    `[notify] persona ${person.id} (modo ${notifyMode()}): ${subs.length} suscripción(es), ` +
      `${results.length} intento(s), ${sent} ${relay ? 'relevado(s)' : 'enviado(s)'}`
  );
  return results.length;
}

module.exports = {
  sendEmail,
  sendWhatsApp,
  sendVerificationEmail,
  notifySubscribers,
  updateText,
  STATUS_LABEL,
  notifyMode,
  relayEnabled,
  relayToOperators,
  avisoEmail,
  RELAY_SUBJECT_PREFIX
};
