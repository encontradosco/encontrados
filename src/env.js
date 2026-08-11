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

  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN || '',
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
  WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN || 'encontrados-verify'
};
