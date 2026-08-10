const express = require('express');
const env = require('../env');
const { handleInbound } = require('../bot');
const { sendWhatsApp } = require('../notify');

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

  router.post('/whatsapp', async (req, res) => {
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
