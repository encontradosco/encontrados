// Outbound notifications: email (SendGrid), WhatsApp (Meta Cloud API), Telegram.
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

async function sendTelegram(chatId, text) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    console.log(`[notify:telegram skipped — not configured] chat=${chatId}`);
    return false;
  }
  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    }
  );
  if (!res.ok) console.error(`[notify:telegram] ${res.status} ${await res.text()}`);
  return res.ok;
}

// Notify all subscribers of a person about a new update.
// skipAddress: don't echo the update back to whoever reported it.
async function notifySubscribers(store, person, update, { skipAddress } = {}) {
  const subs = await store.getSubscriptions(person.id);
  const text = `🔔 Actualización en Aquí:\n${updateText(person, update)}`;
  const jobs = subs
    .filter((s) => !(skipAddress && s.address === skipAddress))
    .map((s) => {
      if (s.channel === 'email') {
        return sendEmail(s.address, `Actualización sobre ${person.full_name} — Aquí`, text);
      }
      if (s.channel === 'whatsapp') return sendWhatsApp(s.address, text);
      if (s.channel === 'telegram') return sendTelegram(s.address, text);
      return Promise.resolve(false);
    });
  const results = await Promise.allSettled(jobs);
  for (const r of results) {
    if (r.status === 'rejected') console.error('[notify] failed:', r.reason);
  }
  return results.length;
}

module.exports = { sendEmail, sendWhatsApp, sendTelegram, notifySubscribers, updateText, STATUS_LABEL };
