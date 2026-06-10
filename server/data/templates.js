const { getDb, newId } = require('../config/database');
const { toBool, toDate, now } = require('./_map');

function countVariables(body) {
  const m = (body || '').match(/\{\{\s*\d+\s*\}\}/g);
  return m ? new Set(m).size : 0;
}

function mapRow(row) {
  if (!row) return null;
  return {
    _id: row.id, id: row.id, userId: row.userId,
    name: row.name, category: row.category, language: row.language,
    body: row.body, status: row.status, variableCount: row.variableCount,
    timesUsed: row.timesUsed, isActive: toBool(row.isActive),
    createdAt: toDate(row.createdAt), updatedAt: toDate(row.updatedAt),
  };
}

function listForUser(userId) {
  return getDb().prepare('SELECT * FROM templates WHERE userId = ? AND isActive = 1 ORDER BY createdAt DESC')
    .all(userId).map(mapRow);
}
function findForUser(id, userId) {
  return mapRow(getDb().prepare('SELECT * FROM templates WHERE id = ? AND userId = ? AND isActive = 1').get(id, userId));
}
function countForUser(userId) {
  return getDb().prepare('SELECT COUNT(*) c FROM templates WHERE userId = ? AND isActive = 1').get(userId).c;
}

function create(data) {
  const db = getDb();
  const id = newId();
  const ts = now();
  db.prepare(`INSERT INTO templates (id,userId,name,category,language,body,status,variableCount,createdAt,updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    id, data.userId, data.name.trim(), data.category || 'marketing', data.language || 'en',
    data.body, 'draft', countVariables(data.body), ts, ts);
  return mapRow(db.prepare('SELECT * FROM templates WHERE id = ?').get(id));
}

function update(id, userId, fields) {
  const db = getDb();
  const out = { ...fields };
  if (out.body !== undefined) out.variableCount = countVariables(out.body);
  const cols = Object.keys(out);
  if (!cols.length) return findForUser(id, userId);
  const set = cols.map(c => `${c} = ?`).join(', ');
  const res = db.prepare(`UPDATE templates SET ${set}, updatedAt = ? WHERE id = ? AND userId = ? AND isActive = 1`)
    .run(...cols.map(c => out[c]), now(), id, userId);
  if (res.changes === 0) return null;
  return findForUser(id, userId);
}

function softDelete(id, userId) {
  const res = getDb().prepare('UPDATE templates SET isActive = 0, updatedAt = ? WHERE id = ? AND userId = ? AND isActive = 1')
    .run(now(), id, userId);
  return res.changes > 0;
}

module.exports = { listForUser, findForUser, countForUser, create, update, softDelete, mapRow };
