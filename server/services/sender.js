const broadcasts = require('../data/broadcasts');
const contacts = require('../data/contacts');
const templates = require('../data/templates');
const waAccounts = require('../data/whatsappAccounts');
const bmsgs = require('../data/broadcastMessages');
const wa = require('../utils/whatsapp');

/*
 * Broadcast send engine.
 * - sendNow() validates + atomically claims the broadcast, then delivers to the
 *   whole audience with pacing (Meta rate limits) and per-recipient tracking.
 * - startScheduler() fires due scheduled broadcasts every 30s while the app runs.
 * Single Node process (cPanel/Passenger) — no queues needed at this scale.
 */

const PACE_MS = process.env.NODE_ENV === 'test' ? 1 : 150; // ~6 msgs/sec
const inFlight = new Set(); // broadcast ids being sent by THIS process

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Replace {{name}} (and template-style {{1}}) with the contact's name.
function personalize(text, contact) {
  return String(text || '')
    .replace(/\{\{\s*name\s*\}\}/gi, contact.name)
    .replace(/\{\{\s*1\s*\}\}/g, contact.name);
}

async function runBroadcast(b, account, audience, messageText, template) {
  let sent = 0, failed = 0;
  try {
    for (const contact of audience) {
      const rowId = bmsgs.createPending(b._id, b.userId, contact);
      let result;
      if (template) {
        // Approved Meta template: name goes in as variable {{1}}.
        const params = template.variableCount > 0 ? [contact.name] : [];
        result = await wa.sendTemplate(account, contact.phone, template.name, template.language, params);
      } else {
        result = await wa.sendText(account, contact.phone, personalize(messageText, contact));
      }
      if (result.ok) {
        sent++;
        bmsgs.markResult(rowId, { wamid: result.wamid, status: 'sent' });
      } else {
        failed++;
        bmsgs.markResult(rowId, { status: 'failed', error: result.error });
      }
      // Refresh progress counters every 10 messages so the UI can poll.
      if ((sent + failed) % 10 === 0) bmsgs.syncBroadcastCounters(b._id);
      if (audience.length > 1) await sleep(PACE_MS);
    }
  } catch (err) {
    console.error('Broadcast send crashed:', err.message);
  } finally {
    inFlight.delete(b._id);
    bmsgs.syncBroadcastCounters(b._id);
    const finalStatus = sent > 0 ? 'sent' : 'failed';
    broadcasts.update(b._id, b.userId, { status: finalStatus });
    // Keep the sending account's lifetime counters honest.
    if (sent > 0) {
      const fresh = waAccounts.findForUser(account._id, b.userId);
      if (fresh) {
        waAccounts.update(account._id, b.userId, {
          totalMessages: (fresh.totalMessages || 0) + sent,
          messagesThisMonth: (fresh.messagesThisMonth || 0) + sent,
        });
      }
    }
  }
  return { sent, failed };
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

  // Which account sends it? Explicit choice, else the first one with credentials.
  const account = b.accountId
    ? waAccounts.findForUserWithToken(b.accountId, userId)
    : waAccounts.firstSendableForUser(userId);
  if (!account || !wa.credsFor(account)) {
    return {
      error: 'No WhatsApp account with API credentials. Open Accounts, add your Phone Number ID and Access Token from Meta Business Manager, then use "Test Connection".',
      code: 'NO_ACCOUNT',
    };
  }

  // What gets sent?
  let template = null;
  if (b.templateId) {
    template = templates.findForUser(b.templateId, userId);
    if (!template) return { error: 'The template attached to this broadcast no longer exists.', code: 'NO_TEMPLATE' };
  }
  const messageText = b.message;
  if (!template && !messageText) return { error: 'Broadcast has no message or template.', code: 'NO_MESSAGE' };

  // Who receives it?
  const audience = contacts.listAudience(userId, b.audienceTag);
  if (!audience.length) return { error: 'No active contacts match this audience. Add contacts (or check the audience tag) first.', code: 'NO_AUDIENCE' };

  // Atomic claim so two clicks / scheduler+click can't double-send.
  if (!broadcasts.claimForSending(b._id, userId)) return { error: 'This broadcast is already sending.', code: 'BUSY' };
  inFlight.add(b._id);
  broadcasts.update(b._id, userId, { audienceCount: audience.length });

  const promise = runBroadcast(b, account, audience, messageText, template);
  return { started: true, audienceCount: audience.length, promise };
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

module.exports = { sendNow, startScheduler, stopScheduler, tick, personalize };
