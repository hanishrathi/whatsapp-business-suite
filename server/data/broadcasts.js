const { getDb, newId } = require('../config/database');
const { toBool, toDate, fromDate, now } = require('./_map');

function mapRow(row) {
  if (!row) return null;
  return {
    _id: row.id, id: row.id, userId: row.userId,
    name: row.name, accountId: row.accountId || null, templateId: row.templateId || null,
    message: row.message || '', audienceTag: row.audienceTag, audienceCount: row.audienceCount,
    status: row.status, scheduledAt: toDate(row.scheduledAt),
    sentCount: row.sentCount, deliveredCount: row.deliveredCount, readCount: row.readCount,
    isActive: toBool(row.isActive),
    createdAt: toDate(row.createdAt), updatedAt: toDate(row.updatedAt),
  };
}

function listForUser(userId) {
  return getDb().prepare('SELECT * FROM broadcasts WHERE userId = ? AND isActive = 1 ORDER BY createdAt DESC')
    .all(userId).map(mapRow);
}
function countForUser(userId) {
  return getDb().prepare('SELECT COUNT(*) c FROM broadcasts WHERE userId = ? AND isActive = 1').get(userId).c;
}

function create(data) {
  const db = getDb();
  const id = newId();
  const ts = now();
  db.prepare(`INSERT INTO broadcasts (id,userId,name,accountId,templateId,message,audienceTag,audienceCount,status,scheduledAt,createdAt,updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, data.userId, data.name.trim(), data.accountId || null, data.templateId || null,
    data.message || '', data.audienceTag || 'all', data.audienceCount || 0,
    data.scheduledAt ? 'scheduled' : 'draft', fromDate(data.scheduledAt), ts, ts);
  return mapRow(db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(id));
}

function update(id, userId, fields) {
  const db = getDb();
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'scheduledAt') out.scheduledAt = fromDate(v);
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

module.exports = { listForUser, countForUser, create, update, softDelete, mapRow };
