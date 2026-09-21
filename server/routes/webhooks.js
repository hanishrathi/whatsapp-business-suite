const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const bmsgs = require('../data/broadcastMessages');
const contacts = require('../data/contacts');
const waAccounts = require('../data/whatsappAccounts');
const { logSystemAction } = require('../utils/audit');

/*
 * Meta WhatsApp webhook.
 *
 * Handles two payload shapes that both arrive on `changes[].value`:
 *   statuses[] — delivery receipts (sent/delivered/read/failed)
 *   messages[] — inbound messages from customers. These matter for compliance:
 *     - any inbound message opens/extends the 24-hour customer service window
 *     - STOP-style keywords are opt-out requests, which WhatsApp requires
 *       businesses to honour
 *
 * Setup (Meta App Dashboard -> WhatsApp -> Configuration):
 *   Callback URL:  https://YOUR-DOMAIN/api/webhooks/whatsapp
 *   Verify token:  the value of WA_WEBHOOK_VERIFY_TOKEN in your environment
 *   Subscribe to:  messages   (covers both statuses and inbound messages)
 * Optional but recommended: set WA_APP_SECRET (Meta App secret) to verify
 * that calls really come from Meta.
 */

/*
 * Opt-out keywords. Matched on the whole trimmed message, case-insensitively,
 * so "stop" unsubscribes but "please stop sending at 3am" does not — a partial
 * match would unsubscribe people who are mid-conversation.
 * Extend via WA_OPT_OUT_KEYWORDS (comma separated) for other languages.
 */
const DEFAULT_OPT_OUT = ['stop', 'unsubscribe', 'unsub', 'cancel', 'end', 'quit', 'optout', 'opt out', 'opt-out'];
const DEFAULT_OPT_IN = ['start', 'subscribe', 'unstop', 'resume'];

function keywordList(envVar, fallback) {
  const raw = process.env[envVar];
  if (!raw) return fallback;
  return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function classifyInbound(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[.!]+$/, '');
  if (!t) return null;
  if (keywordList('WA_OPT_OUT_KEYWORDS', DEFAULT_OPT_OUT).includes(t)) return 'opt_out';
  if (keywordList('WA_OPT_IN_KEYWORDS', DEFAULT_OPT_IN).includes(t)) return 'opt_in';
  return null;
}

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

/*
 * Inbound message from a customer.
 * `value.metadata.phone_number_id` identifies which of our numbers it arrived
 * on, which is how we attribute it to a user and their contact list.
 */
function handleInboundMessage(value, msg) {
  const phoneNumberId = value.metadata && value.metadata.phone_number_id;
  const account = waAccounts.findByPhoneNumberId(phoneNumberId);
  if (!account) return; // message for a number this install doesn't manage

  const from = msg.from;
  const contact = contacts.findActiveByDigits(account.userId, from);
  if (!contact) return; // unknown sender — nothing to update

  // Any inbound message opens/extends the 24h customer service window.
  contacts.touchInbound(contact._id, account.userId);

  const body = msg.text && msg.text.body;
  // Quick-reply buttons carry their label instead of text.
  const buttonText = (msg.button && msg.button.text)
    || (msg.interactive && msg.interactive.button_reply && msg.interactive.button_reply.title);
  const intent = classifyInbound(body || buttonText);

  if (intent === 'opt_out') {
    contacts.recordOptOut(contact._id, account.userId, 'Replied via WhatsApp');
    logSystemAction('contact.opt_out', {
      userId: account.userId, targetId: contact._id, meta: { via: 'whatsapp_inbound' },
    });
  } else if (intent === 'opt_in') {
    contacts.recordOptIn(contact._id, account.userId, 'Replied via WhatsApp');
    logSystemAction('contact.opt_in', {
      userId: account.userId, targetId: contact._id, meta: { via: 'whatsapp_inbound' },
    });
  }
}

// Delivery status updates + inbound messages.
router.post('/whatsapp', (req, res) => {
  try {
    if (!signatureValid(req)) return res.sendStatus(403);

    const touchedBroadcasts = new Set();
    for (const entry of req.body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};

        // Delivery receipts.
        for (const s of value.statuses || []) {
          // s = { id: wamid, status: 'sent'|'delivered'|'read'|'failed', ... }
          if (!s.id || !s.status) continue;
          const row = bmsgs.advanceStatusByWamid(s.id, s.status);
          if (row) touchedBroadcasts.add(row.broadcastId);
        }

        // Inbound customer messages.
        for (const msg of value.messages || []) {
          try {
            handleInboundMessage(value, msg);
          } catch (err) {
            // One bad message must not drop the rest of the batch.
            console.error('Inbound message handling error:', err.message);
          }
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
