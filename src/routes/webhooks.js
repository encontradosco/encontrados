const express = require('express');
const env = require('../env');
const { handleInbound } = require('../bot');
const { sendWhatsApp } = require('../notify');

function webhookRoutes(store) {
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
    res.sendStatus(200); // ack fast; Meta retries on timeouts
    try {
      const changes = (req.body.entry || []).flatMap((e) => e.changes || []);
      for (const change of changes) {
        for (const msg of change.value?.messages || []) {
          if (msg.type !== 'text' || !msg.from) continue;
          const reply = await handleInbound(store, {
            channel: 'whatsapp',
            from: msg.from,
            text: msg.text.body
          });
          await sendWhatsApp(msg.from, reply);
        }
      }
    } catch (e) {
      console.error('[webhook:whatsapp]', e);
    }
  });

  return router;
}

module.exports = { webhookRoutes };
