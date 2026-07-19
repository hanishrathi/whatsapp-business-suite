const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const bmsgs = require('../data/broadcastMessages');

/*
 * Meta WhatsApp webhook — receives delivery receipts (sent/delivered/read/failed)
 * so broadcast stats reflect reality.
 *
 * Setup (Meta App Dashboard -> WhatsApp -> Configuration):
 *   Callback URL:  https://YOUR-DOMAIN/api/webhooks/whatsapp
 *   Verify token:  the value of WA_WEBHOOK_VERIFY_TOKEN in your environment
 * Optional but recommended: set WA_APP_SECRET (Meta App secret) to verify
 * that calls really come from Meta.
 */

// Subscription handshake (Meta calls this once when you save the webhook URL).
router.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expected = process.env.WA_WEBHOOK_VERIFY_TOKEN;
  if (mode === 'subscribe' && expected && token === expected) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

function signatureValid(req) {
  const secret = process.env.WA_APP_SECRET;
  if (!secret) return true; // signature checking is opt-in
  const header = req.get('x-hub-signature-256') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody || Buffer.alloc(0)).digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Delivery status updates.
router.post('/whatsapp', (req, res) => {
  try {
    if (!signatureValid(req)) return res.sendStatus(403);

    const touchedBroadcasts = new Set();
    for (const entry of req.body.entry || []) {
      for (const change of entry.changes || []) {
        for (const s of (change.value && change.value.statuses) || []) {
          // s = { id: wamid, status: 'sent'|'delivered'|'read'|'failed', ... }
          if (!s.id || !s.status) continue;
          const row = bmsgs.advanceStatusByWamid(s.id, s.status);
          if (row) touchedBroadcasts.add(row.broadcastId);
        }
      }
    }
    for (const id of touchedBroadcasts) bmsgs.syncBroadcastCounters(id);

    // Always 200 quickly — Meta retries aggressively otherwise.
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook processing error:', err.message);
    res.sendStatus(200);
  }
});

module.exports = router;
