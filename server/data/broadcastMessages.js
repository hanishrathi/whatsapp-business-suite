const { getDb, newId } = require('../config/database');
const { now } = require('./_map');

/*
 * One row per recipient per broadcast. Status lifecycle:
 * pending -> sent -> delivered -> read   (or -> failed at any point)
 * Statuses only move forward (a late 'delivered' webhook can't undo 'read').
 */

const STATUS_RANK = { pending: 0, sent: 1, delivered: 2, read: 3, failed: 9 };

function createPending(broadcastId, userId, contact) {
  const db = getDb();
  const id = newId();
  const ts = now();
  db.prepare(`INSERT INTO broadcast_messages (id,broadcastId,userId,contactId,phone,status,createdAt,updatedAt)
              VALUES (?,?,?,?,?,'pending',?,?)`)
    .run(id, broadcastId, userId, contact._id || null, contact.phone, ts, ts);
  return id;
}

function markResult(id, { wamid, status, error, errorCode, billingCategory }) {
  getDb().prepare(`UPDATE broadcast_messages SET wamid = ?, status = ?, error = ?, errorCode = ?,
                   billingCategory = COALESCE(?, billingCategory), updatedAt = ? WHERE id = ?`)
    .run(wamid || null, status, error || null, errorCode == null ? null : errorCode,
         billingCategory || null, now(), id);
}

/*
 * Recipients of a broadcast whose send failed for a reason worth retrying.
 * Permanent failures (not on WhatsApp, blocked, template rejected) are left
 * alone — retrying those wastes quota and hurts the number's quality rating.
 */
function retryableFailures(broadcastId, retryableCodes) {
  const rows = getDb().prepare(
    `SELECT * FROM broadcast_messages WHERE broadcastId = ? AND status = 'failed'`).all(broadcastId);
  return rows.filter(r => r.errorCode == null || retryableCodes.has(r.errorCode));
}

// Put a row back to pending so a retry run can claim it.
function resetToPending(id) {
  getDb().prepare(
    `UPDATE broadcast_messages SET status = 'pending', error = NULL, errorCode = NULL, updatedAt = ? WHERE id = ?`)
    .run(now(), id);
}

/*
 * Unique recipients this number has started business-initiated conversations
 * with in the last rolling 24 hours. Meta's messaging tier caps exactly this,
 * across every broadcast — not per broadcast.
 */
function uniqueRecipientsLast24h(userId) {
  return getDb().prepare(
    `SELECT COUNT(DISTINCT phone) c FROM broadcast_messages
      WHERE userId = ? AND createdAt >= ? AND status != 'failed'`)
    .get(userId, Date.now() - 24 * 60 * 60 * 1000).c;
}

// Phones already messaged in the window — they don't consume fresh tier quota.
function recipientsLast24h(userId) {
  const rows = getDb().prepare(
    `SELECT DISTINCT phone FROM broadcast_messages
      WHERE userId = ? AND createdAt >= ? AND status != 'failed'`)
    .all(userId, Date.now() - 24 * 60 * 60 * 1000);
  return new Set(rows.map(r => r.phone));
}

// Webhook path: advance status by WhatsApp message id. Returns the row (for broadcastId) or null.
function advanceStatusByWamid(wamid, newStatus) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM broadcast_messages WHERE wamid = ?').get(wamid);
  if (!row) return null;
  const cur = STATUS_RANK[row.status] || 0;
  const next = STATUS_RANK[newStatus];
  if (next === undefined || next <= cur) return row; // ignore unknown/backwards
  db.prepare('UPDATE broadcast_messages SET status = ?, updatedAt = ? WHERE id = ?').run(newStatus, now(), row.id);
  return { ...row, status: newStatus };
}

// Counts by status for one broadcast.
function countsForBroadcast(broadcastId) {
  const rows = getDb().prepare('SELECT status, COUNT(*) c FROM broadcast_messages WHERE broadcastId = ? GROUP BY status').all(broadcastId);
  const out = { pending: 0, sent: 0, delivered: 0, read: 0, failed: 0 };
  for (const r of rows) if (out[r.status] !== undefined) out[r.status] = r.c;
  // "sent or better" totals that the UI usually wants:
  out.sentTotal = out.sent + out.delivered + out.read;
  out.total = out.pending + out.sentTotal + out.failed;
  return out;
}

// Sync a broadcast's cached counters from its message rows.
function syncBroadcastCounters(broadcastId) {
  const c = countsForBroadcast(broadcastId);
  getDb().prepare('UPDATE broadcasts SET sentCount = ?, deliveredCount = ?, readCount = ?, failedCount = ?, updatedAt = ? WHERE id = ?')
    .run(c.sentTotal, c.delivered + c.read, c.read, c.failed, now(), broadcastId);
  return c;
}

/* ---------- dashboard stats ---------- */

function startOfDay(offsetDays = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() - offsetDays * 24 * 60 * 60 * 1000;
}

function statsForUser(userId) {
  const db = getDb();
  const notFailed = "status IN ('sent','delivered','read')";

  const messagesToday = db.prepare(
    `SELECT COUNT(*) c FROM broadcast_messages WHERE userId = ? AND ${notFailed} AND createdAt >= ?`)
    .get(userId, startOfDay(0)).c;

  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const monthTotal = db.prepare(
    `SELECT COUNT(*) c FROM broadcast_messages WHERE userId = ? AND ${notFailed} AND createdAt >= ?`)
    .get(userId, monthStart.getTime()).c;

  // last-30-day breakdown for the donut
  const since30 = startOfDay(29);
  const rows = db.prepare(
    'SELECT status, COUNT(*) c FROM broadcast_messages WHERE userId = ? AND createdAt >= ? GROUP BY status')
    .all(userId, since30);
  const breakdown = { pending: 0, sent: 0, delivered: 0, read: 0, failed: 0 };
  for (const r of rows) if (breakdown[r.status] !== undefined) breakdown[r.status] = r.c;

  const attempted = breakdown.sent + breakdown.delivered + breakdown.read + breakdown.failed;
  const deliveredOrBetter = breakdown.delivered + breakdown.read;
  const deliveryRate = attempted ? Math.round((deliveredOrBetter / attempted) * 1000) / 10 : 0;

  // last 7 days series (oldest first)
  const series = [];
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (let i = 6; i >= 0; i--) {
    const from = startOfDay(i);
    const to = from + 24 * 60 * 60 * 1000;
    const sent = db.prepare(
      `SELECT COUNT(*) c FROM broadcast_messages WHERE userId = ? AND ${notFailed} AND createdAt >= ? AND createdAt < ?`)
      .get(userId, from, to).c;
    const delivered = db.prepare(
      `SELECT COUNT(*) c FROM broadcast_messages WHERE userId = ? AND status IN ('delivered','read') AND createdAt >= ? AND createdAt < ?`)
      .get(userId, from, to).c;
    series.push({ day: dayNames[new Date(from).getDay()], sent, delivered });
  }

  return { messagesToday, monthTotal, deliveryRate, breakdown, series };
}

/*
 * Real per-template performance over the last 30 days: read rate among the
 * messages that were actually delivered. Only templates this user has sent
 * appear — no placeholder rows.
 */
function templatePerformanceForUser(userId, limit = 5) {
  const rows = getDb().prepare(`
    SELECT t.name AS name,
           COUNT(*) AS attempted,
           SUM(CASE WHEN bm.status IN ('delivered','read') THEN 1 ELSE 0 END) AS delivered,
           SUM(CASE WHEN bm.status = 'read' THEN 1 ELSE 0 END) AS read
      FROM broadcast_messages bm
      JOIN broadcasts b ON b.id = bm.broadcastId
      JOIN templates  t ON t.id = b.templateId
     WHERE bm.userId = ? AND bm.createdAt >= ?
     GROUP BY t.name
     HAVING attempted > 0
     ORDER BY read DESC, attempted DESC
     LIMIT ?`).all(userId, startOfDay(29), limit);

  return rows.map(r => ({
    name: r.name,
    attempted: r.attempted,
    delivered: r.delivered,
    read: r.read,
    // Read rate is only meaningful against what actually arrived.
    readRate: r.delivered ? Math.round((r.read / r.delivered) * 1000) / 10 : 0,
  }));
}

// Opt-out rate over the whole contact list — a core WhatsApp quality signal.
function consentStatsForUser(userId) {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) c FROM contacts WHERE userId = ? AND isActive = 1').get(userId).c;
  const optedIn = db.prepare(
    'SELECT COUNT(*) c FROM contacts WHERE userId = ? AND isActive = 1 AND optInAt IS NOT NULL AND optOutAt IS NULL').get(userId).c;
  const optedOut = db.prepare(
    'SELECT COUNT(*) c FROM contacts WHERE userId = ? AND isActive = 1 AND optOutAt IS NOT NULL').get(userId).c;
  return {
    total, optedIn, optedOut,
    noConsent: total - optedIn - optedOut,
    optOutRate: total ? Math.round((optedOut / total) * 1000) / 10 : 0,
  };
}

/*
 * Billable message counts for the current calendar month, by category.
 * Combines broadcast sends (templates) with conversation replies (service),
 * which is what Meta bills against.
 */
function billingCountsForUser(userId) {
  const db = getDb();
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const since = monthStart.getTime();
  const delivered = "status IN ('sent','delivered','read')";

  const counts = { marketing: 0, utility: 0, authentication: 0, service: 0 };

  for (const r of db.prepare(
    `SELECT billingCategory cat, COUNT(*) c FROM broadcast_messages
      WHERE userId = ? AND ${delivered} AND createdAt >= ? GROUP BY billingCategory`)
    .all(userId, since)) {
    const key = r.cat || 'marketing'; // rows sent before categories were tracked
    if (counts[key] !== undefined) counts[key] += r.c;
  }

  for (const r of db.prepare(
    `SELECT billingCategory cat, COUNT(*) c FROM messages
      WHERE userId = ? AND direction = 'out' AND ${delivered} AND createdAt >= ? GROUP BY billingCategory`)
    .all(userId, since)) {
    const key = r.cat || 'service';
    if (counts[key] !== undefined) counts[key] += r.c;
  }

  return counts;
}

module.exports = {
  createPending, markResult, advanceStatusByWamid, countsForBroadcast,
  uniqueRecipientsLast24h, recipientsLast24h, retryableFailures, resetToPending,
  syncBroadcastCounters, statsForUser, templatePerformanceForUser, consentStatsForUser,
  billingCountsForUser,
};
