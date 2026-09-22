const { getDb, newId } = require('../config/database');
const { toBool, toDate, toJson, fromJson, fromDate, now } = require('./_map');

function mapRow(row) {
  if (!row) return null;
  return {
    _id: row.id, id: row.id, userId: row.userId,
    name: row.name, accountId: row.accountId || null, templateId: row.templateId || null,
    message: row.message || '', audienceTag: row.audienceTag, audienceCount: row.audienceCount,
    status: row.status, scheduledAt: toDate(row.scheduledAt),
    sentCount: row.sentCount, deliveredCount: row.deliveredCount, readCount: row.readCount,
    failedCount: row.failedCount || 0,
    // Values for template slots {{2}}..{{N}}; {{1}} is always the contact name.
    variables: toJson(row.variables, {}),
    // Why a run stopped early, if it did.
    abortReason: row.abortReason || '',
    isActive: toBool(row.isActive),
    createdAt: toDate(row.createdAt), updatedAt: toDate(row.updatedAt),
  };
}

function listForUser(userId) {
  return getDb().prepare('SELECT * FROM broadcasts WHERE userId = ? AND isActive = 1 ORDER BY createdAt DESC')
    .all(userId).map(mapRow);
}
function findForUser(id, userId) {
  return mapRow(getDb().prepare('SELECT * FROM broadcasts WHERE id = ? AND userId = ? AND isActive = 1').get(id, userId));
}
// Scheduled broadcasts whose time has come (across all users — used by the scheduler).
function listDue() {
  return getDb().prepare(`SELECT * FROM broadcasts WHERE status = 'scheduled' AND isActive = 1 AND scheduledAt IS NOT NULL AND scheduledAt <= ?`)
    .all(Date.now()).map(mapRow);
}
// Atomically claim a broadcast for sending; returns true if this caller won the claim.
function claimForSending(id, userId) {
  const res = getDb().prepare(
    `UPDATE broadcasts SET status = 'sending', updatedAt = ? WHERE id = ? AND userId = ? AND isActive = 1 AND status IN ('draft','scheduled','failed')`)
    .run(now(), id, userId);
  return res.changes === 1;
}
function countForUser(userId) {
  return getDb().prepare('SELECT COUNT(*) c FROM broadcasts WHERE userId = ? AND isActive = 1').get(userId).c;
}

function create(data) {
  const db = getDb();
  const id = newId();
  const ts = now();
  db.prepare(`INSERT INTO broadcasts (id,userId,name,accountId,templateId,message,audienceTag,audienceCount,status,scheduledAt,variables,createdAt,updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, data.userId, data.name.trim(), data.accountId || null, data.templateId || null,
    data.message || '', data.audienceTag || 'all', data.audienceCount || 0,
    data.scheduledAt ? 'scheduled' : 'draft', fromDate(data.scheduledAt),
    fromJson(data.variables || {}), ts, ts);
  return mapRow(db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(id));
}

function update(id, userId, fields) {
  const db = getDb();
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'scheduledAt') out.scheduledAt = fromDate(v);
    else if (k === 'variables') out.variables = fromJson(v || {});
    else out[k] = v;
  }
  const cols = Object.keys(out);
  if (!cols.length) return null;
  const set = cols.map(c => `${c} = ?`).join(', ');
  const res = db.prepare(`UPDATE broadcasts SET ${set}, updatedAt = ? WHERE id = ? AND userId = ? AND isActive = 1`)
    .run(...cols.map(c => out[c]), now(), id, userId);
  if (res.changes === 0) return null;
  return mapRow(db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(id));
}

function softDelete(id, userId) {
  const res = getDb().prepare('UPDATE broadcasts SET isActive = 0, updatedAt = ? WHERE id = ? AND userId = ? AND isActive = 1')
    .run(now(), id, userId);
  return res.changes > 0;
}

module.exports = { listForUser, findForUser, listDue, claimForSending, countForUser, create, update, softDelete, mapRow };
