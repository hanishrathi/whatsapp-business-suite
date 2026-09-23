const express = require('express');
const crypto = require('crypto');
const env = require('../config/env');
const router = express.Router();
const bmsgs = require('../data/broadcastMessages');
const msgs = require('../data/messages');
const contacts = require('../data/contacts');
const waAccounts = require('../data/whatsappAccounts');
const health = require('../data/healthSnapshots');
const wa = require('../utils/whatsapp');
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
 * WA_APP_SECRET (your Meta App secret) is REQUIRED in production: it is the
 * only thing proving a call really came from Meta. The callback URL is not a
 * secret, so without it anyone could post forged inbound messages, fake opt-out
 * keywords, bogus delivery receipts, or account_update events that rewrite the
 * quality rating and messaging tier this app gates real sends on.
 */

/*
 * Opt-out keywords. Matched on the whole trimmed message, case-insensitively,
 * so "stop" unsubscribes but "please stop sending at 3am" does not — a partial
 * match would unsubscribe people who are mid-conversation.
 * Extend via WA_OPT_OUT_KEYWORDS (comma separated) for other languages.
 */
const DEFAULT_OPT_OUT = ['stop', 'unsubscribe', 'unsub', 'cancel', 'end', 'quit', 'optout', 'opt out', 'opt-out'];
const DEFAULT_OPT_IN = ['start', 'subscribe', 'unstop', 'resume'];
/*
 * Marketing-only opt-out. Meta encourages per-category consent: someone who
 * wants no more promotions may still want order updates, so these stop
 * MARKETING templates without silencing utility messages entirely.
 */
const DEFAULT_MARKETING_OPT_OUT = ['stop promotions', 'stop promo', 'no promotions', 'stop marketing', 'no ads'];

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
  if (keywordList('WA_MARKETING_OPT_OUT_KEYWORDS', DEFAULT_MARKETING_OPT_OUT).includes(t)) return 'marketing_opt_out';
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

/*
 * Verify Meta's HMAC signature over the raw request body. Fails closed: an
 * unverifiable payload is rejected rather than trusted. Production boot already
 * refuses to start without WA_APP_SECRET, so the only way to reach the
 * unconfigured branch is a local development run.
 */
function signatureValid(req) {
  const secret = process.env.WA_APP_SECRET;
  if (!secret) {
    if (env.isProduction) return false;   // never trust an unsigned call in production
    console.warn('WA_APP_SECRET is not set — accepting an UNVERIFIED webhook call. Development only.');
    return true;
  }
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

  // Text, or the label of whichever button they tapped.
  const body = (msg.text && msg.text.body) || '';
  const buttonText = (msg.button && msg.button.text)
    || (msg.interactive && msg.interactive.button_reply && msg.interactive.button_reply.title)
    || (msg.interactive && msg.interactive.list_reply && msg.interactive.list_reply.title)
    || '';

  // Store it. Meta redelivers webhooks, so this is idempotent on wamid.
  const { isNew } = msgs.createInboundOnce({
    userId: account.userId, accountId: account._id, contactId: contact._id,
    phone: contact.phone, type: msg.type || 'text',
    body: body || buttonText, wamid: msg.id || null,
  });
  // A redelivery must not re-open the window or re-fire consent changes.
  if (!isNew) return;

  // Any inbound message opens/extends the 24h customer service window.
  contacts.touchInbound(contact._id, account.userId);

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
  } else if (intent === 'marketing_opt_out') {
    contacts.recordMarketingOptOut(contact._id, account.userId);
    logSystemAction('contact.marketing_opt_out', {
      userId: account.userId, targetId: contact._id, meta: { via: 'whatsapp_inbound' },
    });
  }
}

/*
 * account_update: Meta pushes quality-rating changes, messaging-tier changes
 * and ban/restriction events here. Without it the dashboard keeps showing the
 * rating from whenever someone last clicked "Test Connection".
 */
function handleAccountUpdate(value) {
  const phoneNumberId = (value.metadata && value.metadata.phone_number_id)
    || value.phone_number_id;
  const account = phoneNumberId ? waAccounts.findByPhoneNumberId(phoneNumberId) : null;
  if (!account) return;

  const updates = {};
  const qualityMap = { GREEN: 'high', YELLOW: 'medium', RED: 'low' };

  // Quality rating change.
  const rating = (value.current_limit && value.current_limit.quality_rating)
    || value.quality_rating
    || (value.phone_number_quality_update && value.phone_number_quality_update.current_limit);
  if (rating && qualityMap[String(rating).toUpperCase()]) {
    const q = qualityMap[String(rating).toUpperCase()];
    updates.quality = q;
    updates.qualityLabel = q.replace(/^./, c => c.toUpperCase());
    updates.qualityUpdatedAt = new Date();
  }

  // Messaging tier change.
  const tier = value.messaging_limit_tier
    || (value.current_limit && value.current_limit.messaging_limit_tier);
  if (tier) {
    updates.messagingLimit = wa.tierToLimit(tier);
    updates.messagingLimitCheckedAt = new Date();
  }

  // Ban / restriction — the account cannot send until resolved with Meta.
  const banState = value.ban_info
    ? (value.ban_info.waba_ban_state || 'BANNED')
    : (value.decision || value.event);
  if (banState && /BAN|DISABLE|RESTRICT/i.test(String(banState))) {
    updates.banState = String(banState).slice(0, 60);
    updates.status = 'error';
  } else if (banState && /REINSTATE|APPROVE/i.test(String(banState))) {
    updates.banState = '';
    updates.status = 'connected';
  }

  if (!Object.keys(updates).length) return;
  const fresh = waAccounts.update(account._id, account.userId, updates);
  // Record it before the next change overwrites it — this is the only history.
  if (fresh) health.record(fresh, 'webhook');
  logSystemAction('whatsapp_account.meta_update', {
    userId: account.userId, targetId: account._id, meta: updates,
  });
}

// Delivery status updates + inbound messages.
router.post('/whatsapp', (req, res) => {
  try {
    if (!signatureValid(req)) return res.sendStatus(403);

    const touchedBroadcasts = new Set();
    for (const entry of req.body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};

        // account_update carries quality, tier and ban changes, not messages.
        if (change.field === 'account_update' || value.ban_info || value.current_limit) {
          try { handleAccountUpdate(value); } catch (err) {
            console.error('Account update handling error:', err.message);
          }
        }

        // Delivery receipts. A wamid belongs either to a broadcast recipient
        // or to a conversation reply, so both tables get a chance to advance.
        for (const s of value.statuses || []) {
          // s = { id: wamid, status: 'sent'|'delivered'|'read'|'failed', ... }
          if (!s.id || !s.status) continue;
          const row = bmsgs.advanceStatusByWamid(s.id, s.status);
          if (row) touchedBroadcasts.add(row.broadcastId);
          msgs.advanceStatusByWamid(s.id, s.status);
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
