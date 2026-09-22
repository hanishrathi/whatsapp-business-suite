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
 *
 * {{1}} is the contact's name by convention. Slots 2..N come from the
 * broadcast's own `variables` map, which is the same for every recipient.
 * Meta rejects an empty parameter, so a template with a slot nobody filled is
 * refused before the send rather than delivered as "your order  ships on ."
 */
function valuesFor(contact, broadcastVariables) {
  return { 1: contact.name, ...(broadcastVariables || {}) };
}

/*
 * Which of a template's variable slots have no value? Returns the missing
 * indexes so the caller can say exactly what to supply.
 */
function missingVariables(template, broadcastVariables) {
  const declared = wa.countPlaceholders(
    (Array.isArray(template.components) ? template.components : [])
      .filter(c => ['BODY', 'HEADER'].includes(String(c.type).toUpperCase()))
      .map(c => c.text || '').join(' '));
  const have = { 1: true, ...(broadcastVariables || {}) };
  const missing = [];
  for (let i = 1; i <= declared; i++) {
    const v = have[i] ?? have[String(i)];
    if (v === undefined || v === null || String(v).trim() === '') missing.push(i);
  }
  return missing;
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

/*
 * `existingRows` maps phone -> broadcast_messages id. On a retry the rows
 * already exist; reusing them is what stops a retry from doubling the
 * recipient count and leaving phantom 'pending' rows behind.
 */
async function runBroadcast(b, account, audience, template, category, existingRows) {
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

      const rowId = (existingRows && existingRows.get(contact.phone))
        || bmsgs.createPending(b._id, b.userId, contact, account._id);
      const components = wa.buildTemplateComponents(template, valuesFor(contact, b.variables));
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
    /*
     * A run that stopped early is not simply "sent" — some of the audience was
     * never contacted. Record why, so the operator sees it instead of it
     * living only in a server log.
     */
    const finalStatus = abortReason ? 'failed' : (sent > 0 ? 'sent' : 'failed');
    broadcasts.update(b._id, b.userId, {
      status: finalStatus,
      abortReason: abortReason ? String(abortReason).slice(0, 300) : '',
    });
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
 * Messaging tier gate.
 *
 * Meta caps unique recipients per rolling 24h PER PHONE NUMBER, across every
 * broadcast. Returns an error object when the send would exceed it, or null
 * when it is fine — including when the tier is simply not known yet, because
 * refusing a send on a number we invented is worse than letting it through.
 */
function tierGate(account, userId, audience) {
  const limit = account.messagingLimit;
  if (limit == null) return null; // Meta has not told us; do not invent a cap.

  const alreadyMessaged = bmsgs.recipientsLast24h(userId, account._id);
  const fresh = audience.filter(c => !alreadyMessaged.has(c.phone)).length;
  if (alreadyMessaged.size + fresh <= limit) return null;

  const remaining = Math.max(0, limit - alreadyMessaged.size);
  return {
    error: `"${account.name}" is on a ${limit.toLocaleString()}-recipient/24h messaging tier and has already reached ${alreadyMessaged.size.toLocaleString()} unique recipients in the last 24 hours. This send needs ${fresh.toLocaleString()} new ones but only ${remaining.toLocaleString()} remain. Narrow the audience with a tag, or wait for the window to roll forward. Meta raises the tier automatically as you send consistently at good quality.`,
    code: 'OVER_TIER_LIMIT',
    audienceCount: audience.length,
    messagingLimit: limit,
    usedLast24h: alreadyMessaged.size,
    remaining,
  };
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
   * Every variable the template declares must have a value. Meta rejects an
   * empty parameter, and a half-filled template reads as broken to the
   * customer, so this is refused before anything is sent.
   */
  const missing = missingVariables(template, b.variables);
  if (missing.length) {
    return {
      error: `Template "${template.name}" has ${missing.length} variable${missing.length === 1 ? '' : 's'} with no value (${missing.map(i => '{{' + i + '}}').join(', ')}). {{1}} is filled with the contact's name automatically; set the rest on the broadcast before sending.`,
      code: 'MISSING_VARIABLES',
      missing,
    };
  }

  const gate = tierGate(account, userId, audience);
  if (gate) return gate;

  // Atomic claim so two clicks / scheduler+click can't double-send.
  if (!broadcasts.claimForSending(b._id, userId)) return { error: 'This broadcast is already sending.', code: 'BUSY' };
  inFlight.add(b._id);
  broadcasts.update(b._id, userId, { audienceCount: audience.length });

  const promise = runBroadcast(b, account, audience, template, category);
  return { started: true, audienceCount: audience.length, promise };
}

/* ---------- retry ---------- */

/*
 * Retry the recipients of a finished broadcast whose send failed for a
 * transient reason (rate limits, network blips, or an unrecorded cause).
 *
 * Permanent failures are deliberately NOT retried: 131026 means the number is
 * not reachable on WhatsApp, 131049 means Meta suppressed the message to
 * protect the user. Re-sending those burns quota and damages quality.
 */
function retryFailed(broadcastId, userId) {
  const b = broadcasts.findForUser(broadcastId, userId);
  if (!b) return { error: 'Broadcast not found.', code: 'NOT_FOUND' };
  if (b.status === 'sending' || inFlight.has(b._id)) return { error: 'This broadcast is still sending.', code: 'BUSY' };

  const retryable = new Set([
    wa.ERROR_CODES.RATE_LIMIT,
    wa.ERROR_CODES.PAIR_RATE_LIMIT,
    wa.ERROR_CODES.TOO_MANY_REQUESTS,
  ]);
  const rows = bmsgs.retryableFailures(b._id, retryable);
  if (!rows.length) {
    return { error: 'Nothing to retry — no recipients failed for a transient reason.', code: 'NOTHING_TO_RETRY' };
  }

  const account = b.accountId
    ? waAccounts.findForUserWithToken(b.accountId, userId)
    : waAccounts.firstSendableForUser(userId);
  if (!account || account.channelType === 'manual' || !wa.credsFor(account)) {
    return { error: 'No Cloud API account with credentials to retry from.', code: 'NO_ACCOUNT' };
  }
  if (!b.templateId) return { error: 'This broadcast has no template to resend.', code: 'TEMPLATE_REQUIRED' };
  const template = templates.findForUser(b.templateId, userId);
  if (!template || !template.isSendable) {
    return { error: 'The template is no longer approved, so it cannot be resent.', code: 'TEMPLATE_NOT_APPROVED' };
  }

  // Only retry contacts who still consent — consent may have changed since.
  const category = (template.category || 'marketing').toLowerCase();
  const audience = [];
  const existingRows = new Map();
  for (const row of rows) {
    const contact = contacts.findActiveByPhone(userId, row.phone);
    if (!contact || !contact.hasOptIn || contact.status !== 'active') continue;
    if (category === 'marketing' && !contact.acceptsMarketing) continue;
    audience.push(contact);
    // Reuse the existing row. Creating a new one per retry would double the
    // recipient count and strand the old row as permanently 'pending'.
    existingRows.set(contact.phone, row.id);
  }
  if (!audience.length) {
    return { error: 'None of the failed recipients still have valid consent.', code: 'NO_AUDIENCE' };
  }

  // A retry consumes tier quota exactly like a first send does.
  const gate = tierGate(account, userId, audience);
  if (gate) return gate;

  /*
   * Claim BEFORE touching any row. Resetting first and claiming second meant a
   * lost race left rows flipped to 'pending' with no send behind them — they
   * stopped counting as failures, so the Retry button vanished and those
   * recipients were silently dropped.
   */
  if (!broadcasts.claimForSending(b._id, userId)) return { error: 'This broadcast is already sending.', code: 'BUSY' };
  inFlight.add(b._id);
  for (const id of existingRows.values()) bmsgs.resetToPending(id);

  const promise = runBroadcast(b, account, audience, template, category, existingRows);
  return { started: true, retryCount: audience.length, promise };
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
  let category = null;
  if (b.templateId) {
    const template = templates.findForUser(b.templateId, userId);
    if (template) {
      text = template.body;
      category = (template.category || 'marketing').toLowerCase();
    }
  }
  if (!text) return { error: 'This broadcast has no message text to hand off.', code: 'NO_MESSAGE' };

  /*
   * The consent rules do not change because a human presses send. A contact
   * who opted out of marketing must not appear in the links for a marketing
   * broadcast either.
   */
  const audience = contacts.listAudience(userId, b.audienceTag, 5000, category);
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

// Refusals that clear on their own — the broadcast stays scheduled.
const RECOVERABLE_SCHEDULE_CODES = new Set(['OVER_TIER_LIMIT', 'BUSY']);

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
        /*
         * Some refusals are temporary: the tier window rolls forward, and a
         * BUSY claim clears when the other run finishes. Marking those 'failed'
         * meant a campaign that merely arrived at a full moment never went out
         * at all. Leave them scheduled and try again on the next tick.
         */
        if (RECOVERABLE_SCHEDULE_CODES.has(r.code)) {
          console.warn(`Scheduled broadcast ${b._id} deferred: ${r.error}`);
          continue;
        }
        // Anything else is permanent (no credentials, template gone).
        broadcasts.update(b._id, b.userId, { status: 'failed', abortReason: String(r.error).slice(0, 300) });
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
  sendNow, retryFailed, buildHandoffLinks, startScheduler, stopScheduler, tick, personalize,
};
