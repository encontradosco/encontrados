const crypto = require('crypto');
const express = require('express');
const env = require('../env');
const { handleInbound } = require('../bot');
const { sendWhatsApp } = require('../notify');

// Compare two secrets without leaking, through timing, how much of the value
// was right. Both sides are hashed first so the comparison always gets two
// buffers of the same length: `timingSafeEqual` throws when they differ, and a
// length check before it would turn "wrong length" into a faster answer than
// "wrong value".
function secretsMatch(provided, expected) {
  const a = crypto.createHash('sha256').update(String(provided), 'utf8').digest();
  const b = crypto.createHash('sha256').update(String(expected), 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

// The inbound webhook writes to the database: it creates people, updates and
// subscriptions. So it has to know who is calling.
//
// The caller is not Meta. Meta delivers to a relay of ours that verifies its
// HMAC signature and forwards the untouched body here, which makes this a
// single-client endpoint — and a shared secret both simpler and stricter than
// re-implementing the signature check on this side. The relay also forwards
// Meta's `X-Hub-Signature-256` intact, so when `WHATSAPP_APP_SECRET` is
// available here that signature can be verified in depth on top of this. Not
// in this change.
//
// Unconfigured means REJECT, not "open". Nothing legitimate posts here without
// the relay, so failing closed costs nothing and failing open costs the
// database.
function requireRelaySecret(req, res, next) {
  // From process.env, not the src/env.js snapshot: a serverless instance built
  // before the variable was set still sees it, and a test can unset it to
  // exercise the unconfigured path.
  const expected = (process.env.WHATSAPP_RELAY_SECRET || '').trim();
  if (!expected) {
    console.error(
      '[webhook:whatsapp] POST rechazado: WHATSAPP_RELAY_SECRET no está configurada. ' +
        'El webhook no acepta escrituras sin la credencial del relevo; defínela en el entorno ' +
        'con el mismo valor que usa el relevo.'
    );
    return res.sendStatus(403);
  }
  const provided = (req.get('x-relay-secret') || '').trim();
  if (!provided || !secretsMatch(provided, expected)) {
    console.warn('[webhook:whatsapp] POST rechazado: credencial de relevo ausente o incorrecta.');
    return res.sendStatus(403);
  }
  return next();
}

// Download an inbound WhatsApp media attachment via the Graph API.
async function fetchWhatsAppMedia(mediaId) {
  const meta = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}` }
  });
  if (!meta.ok) throw new Error(`media meta ${meta.status}`);
  const { url, mime_type: mimeType } = await meta.json();
  const bin = await fetch(url, { headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}` } });
  if (!bin.ok) throw new Error(`media download ${bin.status}`);
  return { bytes: Buffer.from(await bin.arrayBuffer()), contentType: mimeType || 'image/jpeg' };
}

function webhookRoutes(store, matcher) {
  const router = express.Router();

  // ---- WhatsApp (Meta Cloud API) ----
  // Verification handshake used when registering the webhook in Meta's dashboard.
  router.get('/whatsapp', (req, res) => {
    if (
      req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === env.WHATSAPP_VERIFY_TOKEN
    ) {
      return res.send(req.query['hub.challenge']);
    }
    res.sendStatus(403);
  });

  // The handshake above is a read and stays open; everything below writes.
  router.post('/whatsapp', requireRelaySecret, async (req, res) => {
    // Process BEFORE acknowledging: on serverless, responding first freezes
    // the function and the outbound reply never leaves. Meta allows ~20s.
    try {
      const changes = (req.body.entry || []).flatMap((e) => e.changes || []);
      for (const change of changes) {
        for (const msg of change.value?.messages || []) {
          if (!msg.from) continue;
          let text = null;
          let photo = null;
          if (msg.type === 'text') {
            text = msg.text.body;
          } else if (msg.type === 'button') {
            // Respuesta rápida de una plantilla: Meta no la manda como texto,
            // y sin esto un "Sí, está conmigo" pulsado en el botón se caía en
            // silencio — que es justo la respuesta de la que depende si se
            // entrega o no el contacto de una familia.
            text = (msg.button && (msg.button.text || msg.button.payload)) || '';
          } else if (msg.type === 'image') {
            text = msg.image.caption || '';
            try {
              photo = await fetchWhatsAppMedia(msg.image.id);
            } catch (e) {
              console.error('[webhook:whatsapp media]', e);
            }
            if (!text.trim()) {
              await sendWhatsApp(
                msg.from,
                'Recibí tu foto, pero necesito saber qué hacer con ella. Reenvíala con una leyenda, por ejemplo: "BIEN Juan Pérez" (reporte) o "SUSCRIBIR Juan Pérez" (búsqueda).\n🔒 Las fotos nunca se comparten: solo se usan para reconocimiento facial.'
              );
              continue;
            }
          } else {
            continue;
          }
          const reply = await handleInbound(store, {
            channel: 'whatsapp',
            from: msg.from,
            text,
            photo,
            matcher
          });
          await sendWhatsApp(msg.from, reply);
        }
      }
    } catch (e) {
      console.error('[webhook:whatsapp]', e);
    }
    res.sendStatus(200);
  });

  return router;
}

module.exports = { webhookRoutes };
