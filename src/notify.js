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
        from: { email: env.EMAIL_FROM, name: 'aqui.online' },
        subject,
        content: [{ type: 'text/plain', value: text }]
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

async function sendVerificationEmail(person, sub) {
  const link = `${env.BASE_URL}/verify?token=${sub.verify_token}`;
  return sendEmail(
    sub.address,
    `Confirma tu suscripción a novedades de ${person.full_name} — aqui.online`,
    [
      `Pediste recibir avisos cuando haya novedades de ${person.full_name} en aqui.online.`,
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
async function notifySubscribers(store, person, update, { skipAddress } = {}) {
  const subs = await store.getSubscriptions(person.id);
  const baseText = `🔔 Actualización en aqui.online:\n${updateText(person, update)}`;
  const jobs = subs
    .filter((s) => s.verified && !(skipAddress && s.address === skipAddress))
    .map((s) => {
      const text = `${baseText}\n\nPara dejar de recibir estos avisos: ${unsubscribeLink(s)}`;
      if (s.channel === 'email') {
        return sendEmail(s.address, `Actualización sobre ${person.full_name} — aqui.online`, text);
      }
      if (s.channel === 'whatsapp') return sendWhatsApp(s.address, text);
      return Promise.resolve(false);
    });
  const results = await Promise.allSettled(jobs);
  let sent = 0;
  for (const r of results) {
    if (r.status === 'rejected') console.error('[notify] failed:', r.reason);
    else if (r.value && r.value.ok) sent++;
  }
  console.log(
    `[notify] persona ${person.id}: ${subs.length} suscripción(es), ${results.length} intento(s), ${sent} enviado(s)`
  );
  return results.length;
}

module.exports = {
  sendEmail,
  sendWhatsApp,
  sendVerificationEmail,
  notifySubscribers,
  updateText,
  STATUS_LABEL
};
