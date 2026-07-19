const { getDb, newId } = require('../config/database');
const { toBool, fromBool, toDate, fromDate, now } = require('./_map');

function mapRow(row, includeToken = false) {
  if (!row) return null;
  const o = {
    _id: row.id, id: row.id, userId: row.userId,
    name: row.name, phone: row.phone, countryCode: row.countryCode,
    category: row.category, categoryLabel: row.categoryLabel,
    color: row.color, colorClass: row.colorClass,
    wabaId: row.wabaId, phoneNumberId: row.phoneNumberId,
    status: row.status, quality: row.quality, qualityLabel: row.qualityLabel,
    totalMessages: row.totalMessages, totalContacts: row.totalContacts,
    deliveryRate: row.deliveryRate, messagesThisMonth: row.messagesThisMonth,
    isVerified: toBool(row.isVerified), verifiedAt: toDate(row.verifiedAt),
    isActive: toBool(row.isActive),
    createdAt: toDate(row.createdAt), updatedAt: toDate(row.updatedAt),
  };
  if (includeToken) o.accessToken = row.accessToken || '';
  return o;
}

function listForUser(userId) {
  return getDb().prepare('SELECT * FROM whatsapp_accounts WHERE userId = ? AND isActive = 1 ORDER BY createdAt DESC')
    .all(userId).map(r => mapRow(r));
}
function findForUser(id, userId) {
  return mapRow(getDb().prepare('SELECT * FROM whatsapp_accounts WHERE id = ? AND userId = ? AND isActive = 1').get(id, userId));
}
// Internal use only (send/test): includes the encrypted access token.
function findForUserWithToken(id, userId) {
  return mapRow(getDb().prepare('SELECT * FROM whatsapp_accounts WHERE id = ? AND userId = ? AND isActive = 1').get(id, userId), true);
}
// First account that has API credentials — the default sender.
function firstSendableForUser(userId) {
  return mapRow(getDb().prepare(
    `SELECT * FROM whatsapp_accounts WHERE userId = ? AND isActive = 1 AND phoneNumberId != '' AND accessToken != '' ORDER BY createdAt LIMIT 1`)
    .get(userId), true);
}
function findActiveByPhone(userId, phone) {
  return mapRow(getDb().prepare('SELECT * FROM whatsapp_accounts WHERE userId = ? AND phone = ? AND isActive = 1').get(userId, phone));
}
function countActiveForUser(userId) {
  return getDb().prepare('SELECT COUNT(*) c FROM whatsapp_accounts WHERE userId = ? AND isActive = 1').get(userId).c;
}

function create(data) {
  const db = getDb();
  const id = newId();
  const ts = now();
  db.prepare(`INSERT INTO whatsapp_accounts
    (id,userId,name,phone,countryCode,category,categoryLabel,color,colorClass,wabaId,phoneNumberId,accessToken,status,isVerified,createdAt,updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, data.userId, data.name, data.phone, data.countryCode || '+91',
    data.category || 'general', data.categoryLabel || 'General',
    data.color || '#25D366', data.colorClass || 'green',
    data.wabaId || '', data.phoneNumberId || '', data.accessToken || '',
    data.status || 'offline', fromBool(data.isVerified), ts, ts);
  // returns object WITH token for internal use; route strips it before responding
  return mapRow(db.prepare('SELECT * FROM whatsapp_accounts WHERE id = ?').get(id), true);
}

function update(id, userId, fields) {
  const db = getDb();
  const allowed = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'isVerified') allowed[k] = fromBool(v);
    else if (k === 'verifiedAt') allowed[k] = fromDate(v);
    else allowed[k] = v;
  }
  const cols = Object.keys(allowed);
  if (!cols.length) return findForUser(id, userId);
  const set = cols.map(c => `${c} = ?`).join(', ');
  const res = db.prepare(`UPDATE whatsapp_accounts SET ${set}, updatedAt = ? WHERE id = ? AND userId = ? AND isActive = 1`)
    .run(...cols.map(c => allowed[c]), now(), id, userId);
  if (res.changes === 0) return null;
  return findForUser(id, userId);
}

function softDelete(id, userId) {
  const db = getDb();
  const res = db.prepare(`UPDATE whatsapp_accounts SET isActive = 0, status = 'offline', updatedAt = ? WHERE id = ? AND userId = ? AND isActive = 1`)
    .run(now(), id, userId);
  if (res.changes === 0) return null;
  return mapRow(db.prepare('SELECT * FROM whatsapp_accounts WHERE id = ?').get(id));
}

function deleteAllForUser(userId) {
  getDb().prepare('DELETE FROM whatsapp_accounts WHERE userId = ?').run(userId);
}

module.exports = { listForUser, findForUser, findForUserWithToken, firstSendableForUser, findActiveByPhone, countActiveForUser, create, update, softDelete, deleteAllForUser, mapRow };
