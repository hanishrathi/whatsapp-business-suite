const broadcasts = require('../data/broadcasts');
const contacts = require('../data/contacts');
const templates = require('../data/templates');
const waAccounts = require('../data/whatsappAccounts');
const bmsgs = require('../data/broadcastMessages');
const wa = require('../utils/whatsapp');

/*
 * Broadcast send engine.
 *
 * WhatsApp rules this enforces, in order:
 *  1. A business-initiated message MUST be an APPROVED template. Free-form text
 *     is only legal inside a 24-hour customer service window opened by the
 *     contact's own inbound message.
 *  2. Every recipient must have recorded opt-in and no opt-out. Enforced in the
 *     audience query (data/contacts.js), re-checked per recipient here.
 *  3. Sending must stay inside the number's messaging tier (unique recipients
 *     per rolling 24h) and inside Cloud API throughput.
 *  4. Rate-limit errors get exponential backoff; ecosystem/template/token
 *     errors abort the run instead of burning the whole audience.
 *
 * Single Node process (cPanel/Passenger) — no queues needed at this scale.
 */

// Cloud API accepts ~80 msg/s on standard tiers; 150ms (~6.7/s) leaves ample
// headroom and keeps a long broadcast from looking like a burst.
const PACE_MS = process.env.NODE_ENV === 'test' ? 1 : 150;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = process.env.NODE_ENV === 'test' ? 1 : 1000;
const BACKOFF_CAP_MS = process.env.NODE_ENV === 'test' ? 4 : 60000;

const inFlight = new Set(); // broadcast ids being sent by THIS process

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Replace {{name}} (and template-style {{1}}) with the contact's name.
function personalize(text, contact) {
  return String(text || '')
    .replace(/\{\{\s*name\s*\}\}/gi, contact.name)
    .replace(/\{\{\s*1\s*\}\}/g, contact.name);
}

/*
 * Values for a template's positional variables, for one contact.
 * {{1}} is the contact name by convention; later slots fall back to empty
 * strings, which Meta accepts as long as the count matches.
 */
function valuesFor(contact) {
  return { 1: contact.name };
}

/*
 * Send one message with retry/backoff on transient rate limits.
 * Returns the final result plus how many attempts it took.
 */
async function sendWithRetry(fn) {
  let attempt = 0;
  for (;;) {
    const result = await fn();
    if (result.ok) return result;
    const retryable = wa.isRetryable(result.code) || result.networkError;
    if (!retryable || attempt >= MAX_RETRIES) return result;
    // Exponential backoff: 1s, 2s, 4s … capped. Hammering a rate limit makes it worse.
    const wait = Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt), BACKOFF_CAP_MS);
    await sleep(wait);
    attempt++;
  }
}

async function runBroadcast(b, account, audience, template, category) {
  let sent = 0, failed = 0, skipped = 0;
  let abortReason = null;

  try {
    for (const contact of audience) {
      // Re-check consent at send time: a contact may have sent STOP while this
      // broadcast was running.
      const fresh = contacts.findActiveByPhone(b.userId, contact.phone) || contact;
      if (!fresh.hasOptIn || fresh.status !== 'active') {
        skipped++;
        continue;
      }
      // Marketing consent can be withdrawn separately, and mid-run.
      if (category === 'marketing' && !fresh.acceptsMarketing) {
        skipped++;
        continue;
      }

      const rowId = bmsgs.createPending(b._id, b.userId, contact);
      const components = wa.buildTemplateComponents(template, valuesFor(contact));
      const result = await sendWithRetry(() =>
        wa.sendTemplate(account, contact.phone, template.name, template.language, components));

      if (result.ok) {
        sent++;
        bmsgs.markResult(rowId, { wamid: result.wamid, status: 'sent', billingCategory: category });
      } else {
        failed++;
        bmsgs.markResult(rowId, { status: 'failed', error: result.error, errorCode: result.code, billingCategory: category });

        // Some failures mean the rest of the audience will fail the same way —
        // stop rather than burning thousands of messages and the account's quality.
        if (wa.isFatalForRun(result.code)) {
          abortReason = result.error;
          break;
        }
      }

      // Refresh progress counters every 10 messages so the UI can poll.
      if ((sent + failed) % 10 === 0) bmsgs.syncBroadcastCounters(b._id);
      if (audience.length > 1) await sleep(PACE_MS);
    }
  } catch (err) {
    console.error('Broadcast send crashed:', err.message);
    abortReason = abortReason || err.message;
  } finally {
    inFlight.delete(b._id);
    bmsgs.syncBroadcastCounters(b._id);
    const finalStatus = sent > 0 ? 'sent' : 'failed';
    broadcasts.update(b._id, b.userId, { status: finalStatus });
    // Keep the sending account's lifetime counters honest.
    if (sent > 0) {
      const freshAccount = waAccounts.findForUser(account._id, b.userId);
      if (freshAccount) {
        waAccounts.update(account._id, b.userId, {
          totalMessages: (freshAccount.totalMessages || 0) + sent,
          messagesThisMonth: (freshAccount.messagesThisMonth || 0) + sent,
        });
      }
    }
    if (abortReason) console.error(`Broadcast ${b._id} aborted: ${abortReason}`);
  }
  return { sent, failed, skipped, abortReason };
}

/*
 * Validate + kick off a send. Returns { started, promise } on success or
 * { error, code } on failure. The promise resolves when delivery finishes —
 * routes fire-and-forget it; tests await it.
 */
function sendNow(broadcastId, userId) {
  const b = broadcasts.findForUser(broadcastId, userId);
  if (!b) return { error: 'Broadcast not found.', code: 'NOT_FOUND' };
  if (b.status === 'sending' || inFlight.has(b._id)) return { error: 'This broadcast is already sending.', code: 'BUSY' };
  if (b.status === 'sent') return { error: 'This broadcast was already sent.', code: 'DONE' };

  // Which account sends it? Explicit choice, else the first Cloud API one.
  const account = b.accountId
    ? waAccounts.findForUserWithToken(b.accountId, userId)
    : waAccounts.firstSendableForUser(userId);

  if (!account) {
    return {
      error: 'No WhatsApp account with API credentials. Open Accounts, add your Phone Number ID and Access Token from Meta Business Manager, then use "Test Connection".',
      code: 'NO_ACCOUNT',
    };
  }
  // Manual channels have no API — they are handed off via click-to-chat instead.
  if (account.channelType === 'manual') {
    return {
      error: `"${account.name}" is a WhatsApp Business app / regular WhatsApp number. Meta publishes no API for those, so this app cannot send from it automatically. Use "Open in WhatsApp" on the broadcast to send it yourself, or pick a Cloud API account.`,
      code: 'MANUAL_CHANNEL',
    };
  }
  if (!wa.credsFor(account)) {
    return {
      error: `"${account.name}" has no working API credentials. Add its Phone Number ID and Access Token, then use "Test Connection".`,
      code: 'NO_ACCOUNT',
    };
  }

  /*
   * A broadcast is business-initiated by definition, so it MUST use an
   * approved template. Free-form text is only legal as a reply inside an open
   * 24h customer service window, which is a per-conversation thing, not a
   * broadcast.
   */
  if (!b.templateId) {
    return {
      error: 'A broadcast must use an approved WhatsApp template. Free-form text can only be sent as a reply within 24 hours of a customer messaging you. Attach a template to this broadcast.',
      code: 'TEMPLATE_REQUIRED',
    };
  }
  const template = templates.findForUser(b.templateId, userId);
  if (!template) return { error: 'The template attached to this broadcast no longer exists.', code: 'NO_TEMPLATE' };
  if (!template.isSendable) {
    return {
      error: `Template "${template.name}" is not approved by Meta (status: ${template.metaStatus || 'not synced'}). Only APPROVED templates can be sent. Sync templates on the Accounts page, or submit this one in Meta Business Manager.`,
      code: 'TEMPLATE_NOT_APPROVED',
    };
  }

  /*
   * Who receives it? The audience query excludes anyone without opt-in, and
   * for a MARKETING template additionally excludes anyone who opted out of
   * marketing specifically.
   */
  const category = (template.category || 'marketing').toLowerCase();
  const audience = contacts.listAudience(userId, b.audienceTag, 5000, category);
  if (!audience.length) {
    const excluded = contacts.countExcludedFromAudience(userId, b.audienceTag);
    return {
      error: excluded
        ? `No contacts in this audience have recorded opt-in. ${excluded} contact${excluded === 1 ? ' was' : 's were'} excluded for missing consent, opt-out, or inactive status. WhatsApp requires opt-in before business-initiated messages.`
        : 'No active contacts match this audience. Add contacts (or check the audience tag) first.',
      code: 'NO_AUDIENCE',
    };
  }

  /*
   * Messaging tier: a number may only start business-initiated conversations
   * with N unique recipients per ROLLING 24 hours — across every broadcast,
   * not per broadcast. Count who has already been messaged in the window so a
   * sequence of small blasts can't quietly blow through the tier.
   */
  const limit = account.messagingLimit || 250;
  const alreadyMessaged = bmsgs.recipientsLast24h(userId);
  const freshRecipients = audience.filter(c => !alreadyMessaged.has(c.phone)).length;
  const wouldTotal = alreadyMessaged.size + freshRecipients;
  if (wouldTotal > limit) {
    const remaining = Math.max(0, limit - alreadyMessaged.size);
    return {
      error: `"${account.name}" is on a ${limit.toLocaleString()}-recipient/24h messaging tier and has already reached ${alreadyMessaged.size.toLocaleString()} unique recipients in the last 24 hours. This broadcast needs ${freshRecipients.toLocaleString()} new ones but only ${remaining.toLocaleString()} remain. Narrow the audience with a tag, or wait for the window to roll forward. Meta raises the tier automatically as you send consistently at good quality.`,
      code: 'OVER_TIER_LIMIT',
      audienceCount: audience.length,
      messagingLimit: limit,
      usedLast24h: alreadyMessaged.size,
      remaining,
    };
  }

  // Atomic claim so two clicks / scheduler+click can't double-send.
  if (!broadcasts.claimForSending(b._id, userId)) return { error: 'This broadcast is already sending.', code: 'BUSY' };
  inFlight.add(b._id);
  broadcasts.update(b._id, userId, { audienceCount: audience.length });

  const promise = runBroadcast(b, account, audience, template, category);
  return { started: true, audienceCount: audience.length, promise };
}

/* ---------- click-to-chat handoff (manual channels) ---------- */

/*
 * Manual channels can't be automated, so the app produces a ready-to-send
 * click-to-chat link per recipient. The operator opens each one in their own
 * WhatsApp Business app or regular WhatsApp and presses send.
 *
 * Opt-in is still required — the obligation is the business's regardless of
 * which app the message is typed in.
 */
function buildHandoffLinks(broadcastId, userId) {
  const b = broadcasts.findForUser(broadcastId, userId);
  if (!b) return { error: 'Broadcast not found.', code: 'NOT_FOUND' };

  let text = b.message;
  if (b.templateId) {
    const template = templates.findForUser(b.templateId, userId);
    if (template) text = template.body;
  }
  if (!text) return { error: 'This broadcast has no message text to hand off.', code: 'NO_MESSAGE' };

  const audience = contacts.listAudience(userId, b.audienceTag);
  if (!audience.length) {
    return { error: 'No contacts in this audience have recorded opt-in.', code: 'NO_AUDIENCE' };
  }

  return {
    ok: true,
    links: audience.map(c => ({
      contactId: c._id,
      name: c.name,
      phone: c.phone,
      url: wa.clickToChatUrl(c.phone, personalize(text, c)),
    })),
  };
}

/* ---------- scheduler ---------- */

let timer = null;

// If the process restarted mid-send, broadcasts stuck in 'sending' would hang
// forever. Any 'sending' row this process doesn't own and hasn't touched for
// 10+ minutes is finalized from its per-message rows.
function recoverStale() {
  const { getDb } = require('../config/database');
  const stale = getDb().prepare(
    `SELECT id, userId FROM broadcasts WHERE status = 'sending' AND isActive = 1 AND updatedAt < ?`)
    .all(Date.now() - 10 * 60 * 1000);
  for (const row of stale) {
    if (inFlight.has(row.id)) continue;
    const c = bmsgs.syncBroadcastCounters(row.id);
    broadcasts.update(row.id, row.userId, { status: c.sentTotal > 0 ? 'sent' : 'failed' });
    console.warn(`Recovered stale broadcast ${row.id} after restart (${c.sentTotal} sent, ${c.failed} failed).`);
  }
}

function tick() {
  try {
    recoverStale();
    for (const b of broadcasts.listDue()) {
      const r = sendNow(b._id, b.userId);
      if (r.error) {
        // Can't send (e.g. no credentials): mark failed so it doesn't retry forever.
        broadcasts.update(b._id, b.userId, { status: 'failed' });
        console.error(`Scheduled broadcast ${b._id} could not start: ${r.error}`);
      } else {
        console.log(`Scheduled broadcast ${b._id} started (${r.audienceCount} recipients).`);
      }
    }
  } catch (err) {
    console.error('Scheduler tick error:', err.message);
  }
}

function startScheduler() {
  if (timer) return;
  timer = setInterval(tick, 30 * 1000);
  timer.unref(); // never keep the process alive just for the timer
  setTimeout(tick, 5 * 1000).unref(); // catch up shortly after boot
}

function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  sendNow, buildHandoffLinks, startScheduler, stopScheduler, tick, personalize,
};
