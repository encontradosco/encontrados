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

async function sendEmail(to, subject, text) {
  if (!env.SENDGRID_API_KEY) {
    console.log(`[notify:email skipped — no SENDGRID_API_KEY] to=${to} subject=${subject}`);
    return false;
  }
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: env.EMAIL_FROM, name: 'Aquí' },
      subject,
      content: [{ type: 'text/plain', value: text }]
    })
  });
  if (!res.ok) console.error(`[notify:email] ${res.status} ${await res.text()}`);
  return res.ok;
}

async function sendWhatsApp(to, text) {
  if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
    console.log(`[notify:whatsapp skipped — not configured] to=${to}`);
    return false;
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
  if (!res.ok) console.error(`[notify:whatsapp] ${res.status} ${await res.text()}`);
  return res.ok;
}

function unsubscribeLink(sub) {
  return `${env.BASE_URL}/unsubscribe?token=${sub.verify_token}`;
}

async function sendVerificationEmail(person, sub) {
  const link = `${env.BASE_URL}/verify?token=${sub.verify_token}`;
  return sendEmail(
    sub.address,
    `Confirma tu suscripción a novedades de ${person.full_name} — Aquí`,
    [
      `Pediste recibir avisos cuando haya novedades de ${person.full_name} en Aquí.`,
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
  const baseText = `🔔 Actualización en Aquí:\n${updateText(person, update)}`;
  const jobs = subs
    .filter((s) => s.verified && !(skipAddress && s.address === skipAddress))
    .map((s) => {
      const text = `${baseText}\n\nPara dejar de recibir estos avisos: ${unsubscribeLink(s)}`;
      if (s.channel === 'email') {
        return sendEmail(s.address, `Actualización sobre ${person.full_name} — Aquí`, text);
      }
      if (s.channel === 'whatsapp') return sendWhatsApp(s.address, text);
      return Promise.resolve(false);
    });
  const results = await Promise.allSettled(jobs);
  for (const r of results) {
    if (r.status === 'rejected') console.error('[notify] failed:', r.reason);
  }
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
