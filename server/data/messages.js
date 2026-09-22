const { getDb, newId } = require('../config/database');
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

const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const STATUS_RANK = { received: 0, pending: 0, sent: 1, delivered: 2, read: 3, failed: 9 };

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
 * One row per contact who has any message traffic: the latest message, how many
 * inbound messages are unread, and whether the 24h window is still open.
 */
function listConversations(userId, limit = 100) {
  const rows = getDb().prepare(`
    SELECT m.contactId, m.phone,
           MAX(m.createdAt) AS lastAt,
           COUNT(*) AS total
      FROM messages m
     WHERE m.userId = ? AND m.contactId IS NOT NULL
     GROUP BY m.contactId
     ORDER BY lastAt DESC
     LIMIT ?`).all(userId, limit);

  const db = getDb();
  return rows.map(r => {
    const last = db.prepare(
      'SELECT * FROM messages WHERE contactId = ? ORDER BY createdAt DESC LIMIT 1').get(r.contactId);
    const contact = db.prepare('SELECT name, status, optInAt, optOutAt FROM contacts WHERE id = ?').get(r.contactId);
    const lastInbound = db.prepare(
      `SELECT createdAt FROM messages WHERE contactId = ? AND direction = 'in' ORDER BY createdAt DESC LIMIT 1`).get(r.contactId);
    return {
      contactId: r.contactId,
      name: (contact && contact.name) || r.phone,
      phone: r.phone,
      status: contact && contact.status,
      hasOptIn: !!(contact && contact.optInAt && !contact.optOutAt),
      lastMessage: last ? (last.body || `[${last.type}]`) : '',
      lastDirection: last && last.direction,
      lastAt: toDate(r.lastAt),
      total: r.total,
      serviceWindowOpen: !!lastInbound && (Date.now() - lastInbound.createdAt) < SERVICE_WINDOW_MS,
      windowExpiresAt: lastInbound ? toDate(lastInbound.createdAt + SERVICE_WINDOW_MS) : null,
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
