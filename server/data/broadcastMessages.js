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

function markResult(id, { wamid, status, error }) {
  getDb().prepare('UPDATE broadcast_messages SET wamid = ?, status = ?, error = ?, updatedAt = ? WHERE id = ?')
    .run(wamid || null, status, error || null, now(), id);
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

module.exports = { createPending, markResult, advanceStatusByWamid, countsForBroadcast, syncBroadcastCounters, statsForUser };
