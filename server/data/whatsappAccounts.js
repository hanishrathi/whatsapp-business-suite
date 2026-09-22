const { getDb, newId } = require('../config/database');
const { toBool, fromBool, toDate, fromDate, now } = require('./_map');

/*
 * Two channel types share this table:
 *
 *  'cloud_api' — a number registered to the WhatsApp Business Platform. The app
 *                sends through it automatically. Such a number CANNOT also be
 *                used in the WhatsApp Business app or regular WhatsApp.
 *  'manual'    — a WhatsApp Business app or regular WhatsApp number. Meta
 *                publishes no API for these, so the app manages contacts and
 *                message text and hands off via click-to-chat. Automated
 *                sending is refused for this type.
 */
const CHANNEL_TYPES = ['cloud_api', 'manual'];

function mapRow(row, includeToken = false) {
  if (!row) return null;
  const channelType = CHANNEL_TYPES.includes(row.channelType) ? row.channelType : 'cloud_api';
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
    channelType,
    // Only Cloud API numbers can be automated.
    canAutoSend: channelType === 'cloud_api',
    messagingLimit: row.messagingLimit == null ? 250 : row.messagingLimit,
    messagingLimitCheckedAt: toDate(row.messagingLimitCheckedAt),
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
// First Cloud API account with credentials — the default automated sender.
// Manual (Business app / regular WhatsApp) accounts are never picked here.
function firstSendableForUser(userId) {
  return mapRow(getDb().prepare(
    `SELECT * FROM whatsapp_accounts WHERE userId = ? AND isActive = 1
     AND COALESCE(channelType,'cloud_api') = 'cloud_api'
     AND phoneNumberId != '' AND accessToken != '' ORDER BY createdAt LIMIT 1`)
    .get(userId), true);
}

// Resolve the account a webhook belongs to, by the business phone number id
// Meta reports in the payload. Used to attribute inbound messages to a user.
function findByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;
  return mapRow(getDb().prepare(
    `SELECT * FROM whatsapp_accounts WHERE phoneNumberId = ? AND isActive = 1 LIMIT 1`)
    .get(String(phoneNumberId)));
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
  const channelType = CHANNEL_TYPES.includes(data.channelType) ? data.channelType : 'cloud_api';
  db.prepare(`INSERT INTO whatsapp_accounts
    (id,userId,name,phone,countryCode,category,categoryLabel,color,colorClass,wabaId,phoneNumberId,accessToken,status,isVerified,channelType,createdAt,updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, data.userId, data.name, data.phone, data.countryCode || '+91',
    data.category || 'general', data.categoryLabel || 'General',
    data.color || '#25D366', data.colorClass || 'green',
    data.wabaId || '', data.phoneNumberId || '', data.accessToken || '',
    data.status || 'offline', fromBool(data.isVerified), channelType, ts, ts);
  // returns object WITH token for internal use; route strips it before responding
  return mapRow(db.prepare('SELECT * FROM whatsapp_accounts WHERE id = ?').get(id), true);
}

function update(id, userId, fields) {
  const db = getDb();
  const allowed = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'isVerified') allowed[k] = fromBool(v);
    else if (k === 'verifiedAt' || k === 'messagingLimitCheckedAt' || k === 'qualityUpdatedAt') allowed[k] = fromDate(v);
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

module.exports = {
  listForUser, findForUser, findForUserWithToken, firstSendableForUser,
  findActiveByPhone, findByPhoneNumberId, countActiveForUser,
  create, update, softDelete, deleteAllForUser, mapRow,
  CHANNEL_TYPES,
};
