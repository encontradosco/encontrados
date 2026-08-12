// Tiny .env loader — no dependency needed. Values already in process.env win.
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const [, key, raw] = m;
    if (process.env[key] === undefined) {
      process.env[key] = raw.replace(/^["']|["']$/g, '');
    }
  }
}

// On Vercel, derive the public URL from the deployment env so email links work
// even without BASE_URL configured.
const defaultBaseUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000';

module.exports = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  BASE_URL: process.env.BASE_URL || defaultBaseUrl,
  DB_PATH: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'encontrados.db'),
  API_KEY: process.env.API_KEY || '',

  // Trim: a stray newline from copy-paste makes SendGrid return 401.
  SENDGRID_API_KEY: (process.env.SENDGRID_API_KEY || '').trim(),
  EMAIL_FROM: (process.env.EMAIL_FROM || 'a@torrenegra.com').trim(),
  // Where a rescuer's aviso (POST /rescate/aviso) is mailed so an operator can
  // relay it to the source registry. Unset = no mail; the aviso still lands on
  // the person's timeline.
  AVISO_EMAIL: (process.env.AVISO_EMAIL || '').trim(),

  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN || '',
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
  WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN || 'encontrados-verify',

  // Meta solo acepta texto libre dentro de la ventana de 24 h que abre un
  // mensaje ENTRANTE. Todo lo que iniciemos nosotros fuera de esa ventana tiene
  // que ser una plantilla aprobada, o la API responde 131047 y no llega nada.
  // Un rescatista llega por la web, no por WhatsApp: su primer mensaje SIEMPRE
  // lo iniciamos nosotros, así que sin plantilla configurada no sale.
  //
  // El nombre no se quema acá porque lo aprueba Meta del lado de la cuenta, y
  // cambia sin que este código tenga nada que decir al respecto.
  WHATSAPP_TEMPLATE_RESCUE_CONFIRM: (process.env.WHATSAPP_TEMPLATE_RESCUE_CONFIRM || '').trim(),
  WHATSAPP_TEMPLATE_LOCALE: (process.env.WHATSAPP_TEMPLATE_LOCALE || 'es').trim()
};
