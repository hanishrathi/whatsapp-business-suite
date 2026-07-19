const { getDb, newId } = require('../config/database');
const { toBool, toDate, toJson, fromJson, fromDate, now } = require('./_map');

function mapRow(row) {
  if (!row) return null;
  return {
    _id: row.id, id: row.id, userId: row.userId,
    name: row.name, phone: row.phone, email: row.email || '',
    tags: toJson(row.tags, []), notes: row.notes || '',
    accountId: row.accountId || null, status: row.status,
    lastContacted: toDate(row.lastContacted), isActive: toBool(row.isActive),
    createdAt: toDate(row.createdAt), updatedAt: toDate(row.updatedAt),
  };
}

function listForUser(userId, q) {
  const db = getDb();
  if (q) {
    const like = `%${q}%`;
    return db.prepare(`SELECT * FROM contacts WHERE userId = ? AND isActive = 1
      AND (name LIKE ? OR phone LIKE ? OR email LIKE ?) ORDER BY createdAt DESC LIMIT 500`)
      .all(userId, like, like, like).map(mapRow);
  }
  return db.prepare('SELECT * FROM contacts WHERE userId = ? AND isActive = 1 ORDER BY createdAt DESC LIMIT 500')
    .all(userId).map(mapRow);
}
function findActiveByPhone(userId, phone) {
  return mapRow(getDb().prepare('SELECT * FROM contacts WHERE userId = ? AND phone = ? AND isActive = 1').get(userId, phone));
}
function countForUser(userId) {
  return getDb().prepare('SELECT COUNT(*) c FROM contacts WHERE userId = ? AND isActive = 1').get(userId).c;
}
// Count active contacts, optionally filtered by a tag (for broadcast audience).
function countAudience(userId, tag) {
  const db = getDb();
  if (!tag || tag === 'all') {
    return db.prepare(`SELECT COUNT(*) c FROM contacts WHERE userId = ? AND isActive = 1 AND status = 'active'`).get(userId).c;
  }
  return db.prepare(`SELECT COUNT(*) c FROM contacts WHERE userId = ? AND isActive = 1 AND status = 'active' AND tags LIKE ?`)
    .get(userId, `%"${tag}"%`).c;
}

// Full audience rows for an actual send (bigger cap than the UI list).
function listAudience(userId, tag, limit = 5000) {
  const db = getDb();
  if (!tag || tag === 'all') {
    return db.prepare(`SELECT * FROM contacts WHERE userId = ? AND isActive = 1 AND status = 'active' ORDER BY createdAt LIMIT ?`)
      .all(userId, limit).map(mapRow);
  }
  return db.prepare(`SELECT * FROM contacts WHERE userId = ? AND isActive = 1 AND status = 'active' AND tags LIKE ? ORDER BY createdAt LIMIT ?`)
    .all(userId, `%"${tag}"%`, limit).map(mapRow);
}

// All active contacts for CSV export (any status).
function listForExport(userId, limit = 20000) {
  return getDb().prepare('SELECT * FROM contacts WHERE userId = ? AND isActive = 1 ORDER BY createdAt LIMIT ?')
    .all(userId, limit).map(mapRow);
}

// Bulk import: inserts rows, skipping invalid ones and duplicates. One transaction.
function bulkCreate(userId, rows) {
  const db = getDb();
  let added = 0, skipped = 0;
  const errors = [];
  const run = db.transaction(() => {
    for (const r of rows) {
      const name = typeof r.name === 'string' ? r.name.trim() : '';
      const phone = typeof r.phone === 'string' || typeof r.phone === 'number' ? String(r.phone).trim() : '';
      if (!name || !phone) { skipped++; continue; }
      try {
        create({
          userId, name, phone,
          email: typeof r.email === 'string' ? r.email : '',
          tags: r.tags, notes: typeof r.notes === 'string' ? r.notes : '',
        });
        added++;
      } catch (err) {
        skipped++;
        if (err.code !== 11000 && errors.length < 5) errors.push(err.message);
      }
    }
  });
  run();
  return { added, skipped, errors };
}

function create(data) {
  const db = getDb();
  const id = newId();
  const ts = now();
  const tags = Array.isArray(data.tags) ? data.tags
    : (data.tags ? String(data.tags).split(',').map(t => t.trim()).filter(Boolean) : []);
  try {
    db.prepare(`INSERT INTO contacts (id,userId,name,phone,email,tags,notes,accountId,createdAt,updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      id, data.userId, data.name.trim(), String(data.phone).trim(), (data.email || '').trim(),
      fromJson(tags), data.notes || '', data.accountId || null, ts, ts);
  } catch (err) {
    if (/UNIQUE/i.test(err.message)) { const e = new Error('duplicate'); e.code = 11000; throw e; }
    throw err;
  }
  return mapRow(db.prepare('SELECT * FROM contacts WHERE id = ?').get(id));
}

function update(id, userId, fields) {
  const db = getDb();
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'tags') out.tags = fromJson(Array.isArray(v) ? v : String(v).split(',').map(t => t.trim()).filter(Boolean));
    else if (k === 'lastContacted') out.lastContacted = fromDate(v);
    else out[k] = v;
  }
  const cols = Object.keys(out);
  if (!cols.length) return null;
  const set = cols.map(c => `${c} = ?`).join(', ');
  const res = db.prepare(`UPDATE contacts SET ${set}, updatedAt = ? WHERE id = ? AND userId = ? AND isActive = 1`)
    .run(...cols.map(c => out[c]), now(), id, userId);
  if (res.changes === 0) return null;
  return mapRow(db.prepare('SELECT * FROM contacts WHERE id = ?').get(id));
}

function softDelete(id, userId) {
  const res = getDb().prepare('UPDATE contacts SET isActive = 0, updatedAt = ? WHERE id = ? AND userId = ? AND isActive = 1')
    .run(now(), id, userId);
  return res.changes > 0;
}

module.exports = { listForUser, listAudience, listForExport, bulkCreate, findActiveByPhone, countForUser, countAudience, create, update, softDelete, mapRow };
