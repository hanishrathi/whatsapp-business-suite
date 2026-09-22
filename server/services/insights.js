const { getDb } = require('../config/database');
const waAccounts = require('../data/whatsappAccounts');
const bmsgs = require('../data/broadcastMessages');
const health = require('../data/healthSnapshots');
const billing = require('../utils/billing');
const wa = require('../utils/whatsapp');

/*
 * Insights — the signals Meta actually judges a WhatsApp Business Account on,
 * each paired with what it means and what it does to the business.
 *
 * Every signal returns the same shape so the UI can render it uniformly:
 *   { key, label, value, display, status, what, impact, action, detail }
 *
 *   status: 'good' | 'watch' | 'act'   — 'act' means it is costing you now.
 *   what:   plain English, no jargon, for someone who does not know the platform.
 *   impact: the concrete business consequence, not a restatement of the number.
 *   action: the next thing to do, or null when nothing is needed.
 *
 * Nearly all of this is DERIVED from message and contact rows the app already
 * stores. The only separately collected data is the daily account-health
 * snapshot, because Meta overwrites quality and tier in place.
 */

const DAY = 86400000;

function pct(part, whole) {
  return whole ? Math.round((part / whole) * 1000) / 10 : 0;
}

/* ---------- raw gathering ---------- */

function messageCounts(userId, sinceMs) {
  const db = getDb();
  // Broadcast recipients and conversation replies both count as traffic.
  const b = db.prepare(
    `SELECT status, COUNT(*) c FROM broadcast_messages WHERE userId = ? AND createdAt >= ? GROUP BY status`)
    .all(userId, sinceMs);
  const m = db.prepare(
    `SELECT status, COUNT(*) c FROM messages WHERE userId = ? AND direction = 'out' AND createdAt >= ? GROUP BY status`)
    .all(userId, sinceMs);
  const out = { pending: 0, sent: 0, delivered: 0, read: 0, failed: 0 };
  for (const r of [...b, ...m]) if (out[r.status] !== undefined) out[r.status] += r.c;
  out.attempted = out.sent + out.delivered + out.read + out.failed;
  out.deliveredOrBetter = out.delivered + out.read;
  return out;
}

function failuresByCode(userId, sinceMs) {
  return getDb().prepare(
    `SELECT errorCode, COUNT(*) c, MAX(error) sample FROM broadcast_messages
      WHERE userId = ? AND status = 'failed' AND createdAt >= ?
      GROUP BY errorCode ORDER BY c DESC`).all(userId, sinceMs);
}

function inboundCount(userId, sinceMs) {
  return getDb().prepare(
    `SELECT COUNT(*) c FROM messages WHERE userId = ? AND direction = 'in' AND createdAt >= ?`)
    .get(userId, sinceMs).c;
}

/*
 * How many inbound messages got a reply while the 24h window was still open.
 * Answering in-window is the cheap path: no template fee, and (until the
 * October 2026 change) no fee at all.
 *
 * One pass. The earlier version ran a query per inbound message, so a tenant
 * with 5,000 inbound messages blocked the single Node process for 5,000
 * round-trips just to open the Insights page.
 */
function windowResponse(userId, sinceMs) {
  const rows = getDb().prepare(
    `SELECT contactId, direction, createdAt FROM messages
      WHERE userId = ? AND contactId IS NOT NULL AND createdAt >= ?
      ORDER BY contactId, createdAt`).all(userId, sinceMs);
  if (!rows.length) return { inbound: 0, answered: 0, rate: 0, medianMinutes: null };

  let inbound = 0, answered = 0;
  const gaps = [];
  // Walk each contact's timeline once; an inbound is answered by the next
  // outbound within 24h, and consecutive inbounds share that same reply.
  let pendingInbound = [];
  let currentContact = null;

  const flush = () => { inbound += pendingInbound.length; pendingInbound = []; };

  for (const r of rows) {
    if (r.contactId !== currentContact) { flush(); currentContact = r.contactId; }
    if (r.direction === 'in') {
      pendingInbound.push(r.createdAt);
    } else if (pendingInbound.length) {
      for (const at of pendingInbound) {
        inbound++;
        if (r.createdAt - at <= DAY) { answered++; gaps.push((r.createdAt - at) / 60000); }
      }
      pendingInbound = [];
    }
  }
  flush(); // trailing inbounds with no reply at all

  gaps.sort((a, b) => a - b);
  return {
    inbound, answered, rate: pct(answered, inbound),
    medianMinutes: gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]) : null,
  };
}

/* ---------- the signals ---------- */

function build(userId, { days = 30 } = {}) {
  const since = Date.now() - days * DAY;
  const counts = messageCounts(userId, since);
  const consent = bmsgs.consentStatsForUser(userId);
  const accounts = waAccounts.listForUser(userId).filter(a => a.canAutoSend);
  const signals = [];

  /* --- 1. Quality rating --- */
  const worst = accounts.slice().sort((a, b) =>
    ({ low: 0, medium: 1, high: 2 }[a.quality] ?? 3) - ({ low: 0, medium: 1, high: 2 }[b.quality] ?? 3))[0];
  if (worst) {
    const trend = health.qualityTrend(worst._id);
    const q = worst.quality || 'unknown';
    signals.push({
      key: 'quality',
      label: 'Quality rating',
      value: q,
      display: q === 'high' ? 'Good' : q === 'medium' ? 'Needs attention' : q === 'low' ? 'Poor' : 'Not yet known',
      sub: trend.direction === 'falling' ? `Falling (${trend.from} → ${trend.to})`
         : trend.direction === 'rising' ? `Improving (${trend.from} → ${trend.to})`
         : trend.points > 1 ? 'Steady' : 'Not enough history yet',
      status: q === 'high' ? (trend.direction === 'falling' ? 'watch' : 'good') : q === 'medium' ? 'watch' : q === 'low' ? 'act' : 'watch',
      what: 'Meta’s score for how people react to your messages. It goes down when recipients block you, report you, or simply ignore you, and up when they engage.',
      impact: 'This is the single number that decides whether you are allowed to grow. A healthy rating lets Meta raise how many people you can message per day; a poor one freezes you where you are and, if it stays poor, gets the number restricted. It is not a vanity metric — it is your permission to keep sending.',
      action: q === 'high' && trend.direction !== 'falling' ? null
        : 'Send less often, only to people who asked for it, and make the first line obviously useful. Quality recovers over days of better sending, not instantly.',
      detail: { accountName: worst.name, trend },
    });
  }

  /* --- 2. Daily sending capacity --- */
  if (accounts.length) {
    /*
     * The tier is per phone number, so report the number under the most
     * pressure rather than the roomiest one — quoting the best case tells the
     * operator they have headroom the send they are about to make does not.
     */
    const perAccount = accounts.map(a => {
      const used = bmsgs.uniqueRecipientsLast24h(userId, a._id);
      return { name: a.name, limit: a.messagingLimit, used,
               headroom: a.messagingLimit == null ? null : Math.max(0, a.messagingLimit - used),
               usedPct: a.messagingLimit == null ? null : pct(used, a.messagingLimit) };
    });
    const known = perAccount.filter(a => a.limit != null);
    const tightest = known.sort((a, b) => b.usedPct - a.usedPct)[0];

    if (!known.length) {
      signals.push({
        key: 'capacity',
        label: 'Daily sending capacity',
        value: null,
        display: 'Not known yet',
        sub: 'Meta has not reported a messaging tier for your numbers',
        status: 'watch',
        what: 'Meta caps how many different people you may start a conversation with in any rolling 24 hours. Replying to someone who messaged you first does not count against it.',
        impact: 'Until the cap is known, this app cannot warn you before a broadcast exceeds it — the surplus would simply fail at Meta, wasting the sends and denting your quality rating.',
        action: 'Open Accounts and use "Test Connection" to read your current tier from Meta.',
        detail: { perAccount },
      });
    } else {
      signals.push({
        key: 'capacity',
        label: 'Daily sending capacity',
        value: tightest.usedPct,
        display: `${tightest.used.toLocaleString()} of ${tightest.limit.toLocaleString()} used`,
        sub: known.length > 1
          ? `${tightest.name} is the tightest — ${tightest.headroom.toLocaleString()} more people today`
          : `${tightest.headroom.toLocaleString()} more people you can start a conversation with today`,
        status: tightest.usedPct >= 90 ? 'act' : tightest.usedPct >= 70 ? 'watch' : 'good',
        what: 'Meta caps how many different people you may start a conversation with in any rolling 24 hours, separately for each of your numbers. Replying to someone who messaged you first does not count against it.',
        impact: 'This is a hard ceiling on campaign size. Queue a broadcast bigger than the headroom and the surplus simply fails — you lose the sends, the customers never hear from you, and the failures drag your quality rating down. Meta raises the cap on its own once you send consistently at good quality.',
        action: tightest.usedPct >= 70
          ? `Split large broadcasts across days, or narrow the audience with a tag. "${tightest.name}" has room for about ${tightest.headroom.toLocaleString()} more people today.`
          : null,
        detail: { perAccount },
      });
    }
  }

  /* --- 3. Delivery rate --- */
  if (counts.attempted) {
    const rate = pct(counts.deliveredOrBetter, counts.attempted);
    signals.push({
      key: 'delivery',
      label: 'Delivery rate',
      value: rate,
      display: `${rate}%`,
      sub: `${counts.deliveredOrBetter.toLocaleString()} of ${counts.attempted.toLocaleString()} reached a phone`,
      status: rate >= 90 ? 'good' : rate >= 75 ? 'watch' : 'act',
      what: 'The share of messages you sent that actually arrived on someone’s phone. Anything below roughly 90% usually means the list contains numbers that are wrong, not on WhatsApp, or have blocked you.',
      impact: 'You are charged per message Meta accepts, so undelivered sends are money spent on nothing. Worse, a list full of dead numbers is exactly the pattern Meta reads as spam, so a poor delivery rate quietly pulls your quality rating down too.',
      action: rate < 90 ? 'Clean the list: remove numbers that keep failing, and check contacts are stored with the country code. The failure breakdown below shows which reason dominates.' : null,
      detail: counts,
    });
  }

  /* --- 4. Read rate --- */
  if (counts.deliveredOrBetter) {
    const rate = pct(counts.read, counts.deliveredOrBetter);
    signals.push({
      key: 'read',
      label: 'Read rate',
      value: rate,
      display: `${rate}%`,
      sub: `${counts.read.toLocaleString()} of ${counts.deliveredOrBetter.toLocaleString()} delivered messages were opened`,
      status: rate >= 50 ? 'good' : rate >= 25 ? 'watch' : 'act',
      what: 'Of the messages that arrived, how many were actually opened. WhatsApp messages are normally read far more than email — a low rate here means the content is not wanted, not that the channel is weak.',
      impact: 'Meta watches read rates on marketing messages and will start pausing a template that people consistently ignore, which stops that campaign outright. Persistently low engagement also feeds back into the quality rating.',
      action: rate < 50 ? 'Message people closer to when they last interacted with you, and lead with something they asked for rather than a generic promotion.' : null,
      detail: { read: counts.read, delivered: counts.deliveredOrBetter },
    });
  }

  /* --- 5. Opt-out rate --- */
  signals.push({
    key: 'optout',
    label: 'Opt-out rate',
    value: consent.optOutRate,
    display: `${consent.optOutRate}%`,
    sub: `${consent.optedOut.toLocaleString()} of ${consent.total.toLocaleString()} contacts asked you to stop`,
    status: consent.optOutRate >= 3 ? 'act' : consent.optOutRate >= 1 ? 'watch' : 'good',
    what: 'The share of your contacts who told you to stop, by replying STOP or being unsubscribed manually. They are permanently excluded from every broadcast.',
    impact: 'This is the clearest early warning that you are messaging too often or messaging the wrong people. It also shrinks the audience you spent money acquiring — and every opt-out is someone who was more likely to block or report you next, which is what actually damages the account.',
    action: consent.optOutRate >= 1 ? 'Cut frequency before you cut content. Most opt-out spikes come from sending twice in a week to people who expected once a month.' : null,
    detail: consent,
  });

  /* --- 6. Consent coverage --- */
  signals.push({
    key: 'consent',
    label: 'Consent coverage',
    value: pct(consent.optedIn, consent.total),
    display: `${pct(consent.optedIn, consent.total)}%`,
    sub: consent.noConsent
      ? `${consent.noConsent.toLocaleString()} contact${consent.noConsent === 1 ? ' has' : 's have'} no recorded opt-in`
      : 'Every contact has recorded consent',
    status: consent.noConsent === 0 ? 'good' : pct(consent.noConsent, consent.total) > 25 ? 'act' : 'watch',
    what: 'How many of your contacts have a stored record of agreeing to hear from you on WhatsApp, including where that agreement came from.',
    impact: 'Contacts without it cannot be messaged at all — this app blocks it — so they are dead weight in your list. And if Meta or a regulator asks you to show consent, the record is the only thing that answers them. Messaging without it is the fastest way to lose the number permanently.',
    action: consent.noConsent ? `Record where consent came from for the ${consent.noConsent.toLocaleString()} contacts missing it, on the Contacts page. Only do it where it is genuinely true.` : null,
    detail: consent,
  });

  /* --- 7. Why messages failed --- */
  const fails = failuresByCode(userId, since);
  if (fails.length) {
    const total = fails.reduce((a, f) => a + f.c, 0);
    signals.push({
      key: 'failures',
      label: 'Why messages failed',
      value: total,
      display: `${total.toLocaleString()} failed`,
      sub: explainCode(fails[0].errorCode).short + ` is the biggest cause (${fails[0].c})`,
      status: pct(total, counts.attempted || total) > 10 ? 'act' : 'watch',
      what: 'Meta gives a reason code for every message it refuses. The reasons mean very different things — some are your list, some are the platform protecting the recipient, some are a broken setup.',
      impact: 'Each cause costs you differently. Unreachable numbers waste spend and hurt quality; rate limits mean you are sending too fast; a template error means a whole campaign is dead until you fix it. Treating them all as "failed" hides which one is actually costing you.',
      action: 'Work the biggest cause first — the breakdown is below.',
      detail: {
        breakdown: fails.map(f => ({
          code: f.errorCode, count: f.c, ...explainCode(f.errorCode),
        })),
      },
    });
  }

  /* --- 8. Reply speed inside the free window --- */
  const wr = windowResponse(userId, since);
  if (wr.inbound) {
    signals.push({
      key: 'window',
      label: 'Replies within 24 hours',
      value: wr.rate,
      display: `${wr.rate}%`,
      sub: wr.medianMinutes != null
        ? `${wr.answered} of ${wr.inbound} answered, typically in ${wr.medianMinutes} min`
        : `${wr.answered} of ${wr.inbound} answered`,
      status: wr.rate >= 80 ? 'good' : wr.rate >= 50 ? 'watch' : 'act',
      what: 'When a customer messages you, a 24-hour window opens in which you can reply in your own words. After it closes you can only send a pre-approved template.',
      impact: 'The window is the cheap and human way to talk to customers — no template approval, no template fee. Miss it and the same conversation costs you a paid template and reads like a form letter. From 1 October 2026 these replies become billable too, though still cheaper than a marketing template.',
      action: wr.rate < 80 ? 'Check the Conversations page more often, or assign someone to it. Unanswered questions are the most expensive kind of silence on this channel.' : null,
      detail: wr,
    });
  }

  /* --- 9. Spend --- */
  const spendCounts = bmsgs.billingCountsForUser(userId);
  const est = billing.estimate(spendCounts);
  const totalMsgs = Object.values(spendCounts).reduce((a, b) => a + b, 0);
  if (totalMsgs) {
    signals.push({
      key: 'spend',
      label: 'Estimated spend this month',
      value: est.total,
      display: `$${est.total.toFixed(2)}`,
      sub: `${totalMsgs.toLocaleString()} messages across ${est.lines.length} categor${est.lines.length === 1 ? 'y' : 'ies'}`,
      status: 'good',
      what: 'What this month’s messages are likely to cost. Meta charges per message, and the price depends on the category: marketing costs the most, utility and authentication less, and replies inside the 24-hour window are free until 1 October 2026.',
      impact: 'Marketing is roughly twice the price of a utility message, so the same monthly budget buys very different reach depending on what you send. The October change makes free-form replies billable after the first 1,000 per number per month — if support conversations are a large part of your volume, that is a new line on the bill.',
      action: billing.serviceBillingActive()
        ? null
        : `Service replies become billable in ${billing.daysUntilServiceBilling()} days. Set WA_RATE_* to your own market rates so these figures match your invoice.`,
      detail: { lines: est.lines, counts: spendCounts, serviceBillingActive: billing.serviceBillingActive() },
    });
  }

  const worstStatus = signals.some(s => s.status === 'act') ? 'act'
    : signals.some(s => s.status === 'watch') ? 'watch' : 'good';

  return {
    periodDays: days,
    generatedAt: new Date().toISOString(),
    overall: worstStatus,
    headline: headlineFor(worstStatus, signals),
    signals,
  };
}

function headlineFor(status, signals) {
  const acting = signals.filter(s => s.status === 'act');
  const watching = signals.filter(s => s.status === 'watch');
  if (status === 'act') {
    return `${acting.length} thing${acting.length === 1 ? '' : 's'} need${acting.length === 1 ? 's' : ''} attention now: ${acting.map(s => s.label.toLowerCase()).join(', ')}.`;
  }
  if (status === 'watch') {
    return `Everything is working, but keep an eye on ${watching.map(s => s.label.toLowerCase()).join(', ')}.`;
  }
  return 'Your WhatsApp account is healthy. Nothing needs attention.';
}

/*
 * Meta error codes in plain language, with what each one actually costs.
 * https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */
function explainCode(code) {
  const C = wa.ERROR_CODES;
  switch (code) {
    case C.UNDELIVERABLE: return {
      short: 'Number not reachable on WhatsApp',
      meaning: 'The number is not registered on WhatsApp, has blocked you, or is in a country you cannot message. Meta does not say which, for the recipient’s privacy.',
      cost: 'Wasted sends and a lower delivery rate, which feeds into your quality rating.',
      fix: 'Remove numbers that fail this way repeatedly — they will never work.' };
    case C.RATE_LIMIT: return {
      short: 'Sending too fast',
      meaning: 'You exceeded the number of messages Meta will accept per second.',
      cost: 'Temporary — the app backs off and retries automatically, so these usually cost you nothing but time.',
      fix: 'Nothing to do; if it happens constantly, spread broadcasts out.' };
    case C.PAIR_RATE_LIMIT: return {
      short: 'Too many messages to the same person',
      meaning: 'Meta throttled repeated messages to one recipient in a short period.',
      cost: 'A strong hint you are over-contacting individuals, which leads to blocks.',
      fix: 'Check whether the same contact is in several overlapping audiences.' };
    case C.ECOSYSTEM_LIMIT: return {
      short: 'Meta suppressed it to protect the recipient',
      meaning: 'That person has had too many marketing messages from businesses recently, so Meta declined to deliver another one.',
      cost: 'Not your fault alone, but it means marketing to that person is currently unproductive.',
      fix: 'Reduce marketing frequency; send utility messages they actually expect instead.' };
    case C.TEMPLATE_MISSING: return {
      short: 'Template not approved on this account',
      meaning: 'The template name or language does not exist as an approved template on the WhatsApp Business Account being used.',
      cost: 'The whole campaign fails, not just one message.',
      fix: 'Sync templates from Meta, and check the language matches exactly.' };
    case C.TEMPLATE_PARAM_COUNT: return {
      short: 'Template variables do not match',
      meaning: 'The template expects a different number of filled-in values than were sent.',
      cost: 'Every message using that template fails.',
      fix: 'Re-sync the template so the app knows its current shape.' };
    case C.TOKEN_EXPIRED: return {
      short: 'Access token no longer valid',
      meaning: 'The token saved for this account has expired or been revoked in Meta Business Manager.',
      cost: 'Nothing can send at all until it is replaced.',
      fix: 'Generate a new permanent token and update the account.' };
    case null: case undefined: return {
      short: 'Reason not recorded',
      meaning: 'This message failed before Meta returned a reason code, usually a network problem reaching the API.',
      cost: 'Usually transient.',
      fix: 'Retry the broadcast; persistent cases mean a hosting network issue.' };
    default: return {
      short: `Meta error ${code}`,
      meaning: 'An error code this app does not have a plain-English description for yet.',
      cost: 'Unknown — check the code in Meta’s error reference.',
      fix: 'Look up the code in Meta’s Cloud API error documentation.' };
  }
}

module.exports = { build, explainCode };
