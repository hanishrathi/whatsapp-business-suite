const { getDb, newId } = require('../config/database');
const { SERVICE_WINDOW_MS, STATUS_RANK } = require('./_constants');
const { toBool, toDate, now } = require('./_map');

/*
 * Every individual message, inbound and outbound, for the conversations view.
 *
 * Inbound messages matter for more than display: the most recent one decides
 * whether the 24-hour customer service window is open, which is the only time
 * a free-form (non-template) reply is allowed.
 *
 * Broadcast sends keep their own per-recipient rows in broadcast_messages;
 * this table carries conversation traffic.
 */


function mapRow(row) {
  if (!row) return null;
  return {
    _id: row.id, id: row.id, userId: row.userId,
    accountId: row.accountId || null, contactId: row.contactId || null,
    phone: row.phone, direction: row.direction, type: row.type || 'text',
    body: row.body || '', wamid: row.wamid || null, status: row.status,
    error: row.error || null, errorCode: row.errorCode == null ? null : row.errorCode,
    billingCategory: row.billingCategory || '', isBillable: toBool(row.isBillable),
    createdAt: toDate(row.createdAt), updatedAt: toDate(row.updatedAt),
  };
}

function create(data) {
  const db = getDb();
  const id = newId();
  const ts = now();
  db.prepare(`INSERT INTO messages
    (id,userId,accountId,contactId,phone,direction,type,body,wamid,status,error,errorCode,billingCategory,isBillable,createdAt,updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, data.userId, data.accountId || null, data.contactId || null, data.phone,
    data.direction, data.type || 'text', data.body || '', data.wamid || null,
    data.status || (data.direction === 'in' ? 'received' : 'sent'),
    data.error || null, data.errorCode == null ? null : data.errorCode,
    data.billingCategory || '', data.isBillable ? 1 : 0, ts, ts);
  return mapRow(db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
}

// Meta can redeliver a webhook, so an inbound message is stored at most once.
function createInboundOnce(data) {
  if (data.wamid) {
    const existing = getDb().prepare('SELECT * FROM messages WHERE wamid = ?').get(data.wamid);
    if (existing) return { message: mapRow(existing), isNew: false };
  }
  return { message: create({ ...data, direction: 'in' }), isNew: true };
}

/*
 * One row per contact who has any message traffic: the latest message, and
 * whether the 24h window is still open.
 *
 * Done as a single grouped query. The earlier version ran three extra queries
 * per conversation inside a map, which the Conversations page then polled
 * every 15 seconds — ~1,200 queries a minute per open tab for data the
 * grouping already had. Those subqueries also filtered on contactId alone;
 * every predicate here is scoped to userId.
 */
function listConversations(userId, limit = 100) {
  const rows = getDb().prepare(`
    SELECT
      m.contactId                                   AS contactId,
      c.name                                        AS name,
      c.phone                                       AS phone,
      c.status                                      AS status,
      c.optInAt                                     AS optInAt,
      c.optOutAt                                    AS optOutAt,
      COUNT(*)                                      AS total,
      MAX(m.createdAt)                              AS lastAt,
      MAX(CASE WHEN m.direction = 'in' THEN m.createdAt END) AS lastInboundAt
    FROM messages m
    JOIN contacts c ON c.id = m.contactId AND c.userId = m.userId
    WHERE m.userId = ? AND m.contactId IS NOT NULL
    GROUP BY m.contactId
    ORDER BY lastAt DESC
    LIMIT ?`).all(userId, limit);

  if (!rows.length) return [];

  // One extra query total (not per row) for the latest message in each thread.
  const ids = rows.map(r => r.contactId);
  const placeholders = ids.map(() => '?').join(',');
  const latest = getDb().prepare(`
    SELECT m.contactId, m.body, m.type, m.direction
      FROM messages m
      JOIN (SELECT contactId, MAX(createdAt) mx FROM messages
             WHERE userId = ? AND contactId IN (${placeholders}) GROUP BY contactId) t
        ON t.contactId = m.contactId AND t.mx = m.createdAt
     WHERE m.userId = ?`).all(userId, ...ids, userId);
  const lastByContact = new Map(latest.map(l => [l.contactId, l]));

  return rows.map(r => {
    const last = lastByContact.get(r.contactId);
    return {
      contactId: r.contactId,
      name: r.name || r.phone,
      phone: r.phone,
      status: r.status,
      hasOptIn: !!(r.optInAt && !r.optOutAt),
      lastMessage: last ? (last.body || `[${last.type}]`) : '',
      lastDirection: last && last.direction,
      lastAt: toDate(r.lastAt),
      total: r.total,
      serviceWindowOpen: !!r.lastInboundAt && (Date.now() - r.lastInboundAt) < SERVICE_WINDOW_MS,
      windowExpiresAt: r.lastInboundAt ? toDate(r.lastInboundAt + SERVICE_WINDOW_MS) : null,
    };
  });
}

// Full thread for one contact, oldest first.
function listThread(userId, contactId, limit = 200) {
  return getDb().prepare(
    'SELECT * FROM messages WHERE userId = ? AND contactId = ? ORDER BY createdAt DESC LIMIT ?')
    .all(userId, contactId, limit).map(mapRow).reverse();
}

/*
 * Is the 24h customer service window open for this contact? Computed from
 * stored inbound messages rather than a cached flag, so it can never go stale.
 */
function serviceWindow(userId, contactId) {
  const row = getDb().prepare(
    `SELECT createdAt FROM messages WHERE userId = ? AND contactId = ? AND direction = 'in'
      ORDER BY createdAt DESC LIMIT 1`).get(userId, contactId);
  if (!row) return { open: false, lastInboundAt: null, expiresAt: null };
  const expiresAt = row.createdAt + SERVICE_WINDOW_MS;
  return { open: Date.now() < expiresAt, lastInboundAt: toDate(row.createdAt), expiresAt: toDate(expiresAt) };
}

// Webhook path: advance an outbound message's delivery status by wamid.
function advanceStatusByWamid(wamid, newStatus) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM messages WHERE wamid = ?').get(wamid);
  if (!row) return null;
  const cur = STATUS_RANK[row.status] || 0;
  const next = STATUS_RANK[newStatus];
  if (next === undefined || next <= cur) return mapRow(row);
  db.prepare('UPDATE messages SET status = ?, updatedAt = ? WHERE id = ?').run(newStatus, now(), row.id);
  return mapRow({ ...row, status: newStatus });
}

module.exports = {
  create, createInboundOnce, listConversations, listThread,
  serviceWindow, advanceStatusByWamid, mapRow, SERVICE_WINDOW_MS,
};
