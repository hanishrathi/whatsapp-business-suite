const { getDb, newId } = require('../config/database');
const { toBool, toDate, toJson, fromJson, now } = require('./_map');
const { normaliseCategory, categoryOrSafeDefault } = require('./_constants');

/*
 * Message templates.
 *
 * Templates are owned by Meta: they are created and approved inside a WhatsApp
 * Business Account, and only an APPROVED template may be used for a
 * business-initiated message. This table MIRRORS the WABA — `metaStatus` is
 * written by the sync job, never by the user. Drafts created locally exist so
 * you can compose wording before submitting it in Business Manager, but they
 * can never be sent.
 */

// The only Meta status that may be sent.
const SENDABLE_STATUS = 'APPROVED';

/*
 * How many positional variables a template declares. Counts the highest index
 * across every text-bearing component, not just BODY — the send path builds
 * parameters for HEADER too, so counting only BODY made the UI and the sender
 * disagree about a header-only variable.
 */
function countVariables(text) {
  const m = String(text || '').match(/\{\{\s*(\d+)\s*\}\}/g);
  if (!m) return 0;
  return Math.max(...m.map(s => parseInt(s.replace(/\D/g, ''), 10)));
}

// All text a template can interpolate into, for variable counting.
function variableText(components, body) {
  const texts = (Array.isArray(components) ? components : [])
    .filter(c => ['BODY', 'HEADER'].includes(String(c.type).toUpperCase()))
    .map(c => c.text || '');
  return texts.length ? texts.join(' ') : (body || '');
}

// Pull the BODY text out of Meta's components array, for display.
function bodyFromComponents(components) {
  const body = (components || []).find(c => String(c.type).toUpperCase() === 'BODY');
  return (body && body.text) || '';
}

function mapRow(row) {
  if (!row) return null;
  const components = toJson(row.components, []);
  return {
    _id: row.id, id: row.id, userId: row.userId,
    name: row.name, category: row.category, language: row.language,
    body: row.body, status: row.status, variableCount: row.variableCount,
    timesUsed: row.timesUsed, isActive: toBool(row.isActive),
    // Meta-owned fields.
    metaId: row.metaId || '', metaStatus: row.metaStatus || '',
    rejectedReason: row.rejectedReason || '',
    components,
    accountId: row.accountId || null,
    syncedAt: toDate(row.syncedAt),
    // The single source of truth for "can this be sent?".
    isSendable: row.metaStatus === SENDABLE_STATUS,
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
function findByNameLang(userId, name, language) {
  return mapRow(getDb().prepare(
    'SELECT * FROM templates WHERE userId = ? AND name = ? AND language = ? AND isActive = 1')
    .get(userId, name, language));
}
function countForUser(userId) {
  return getDb().prepare('SELECT COUNT(*) c FROM templates WHERE userId = ? AND isActive = 1').get(userId).c;
}

// Locally composed draft. Never sendable — it has no Meta status until synced.
function create(data) {
  const db = getDb();
  const id = newId();
  const ts = now();
  db.prepare(`INSERT INTO templates (id,userId,name,category,language,body,status,variableCount,metaStatus,components,createdAt,updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, data.userId, data.name.trim(), categoryOrSafeDefault(data.category), data.language || 'en',
    data.body, 'draft', countVariables(data.body), '',
    fromJson([{ type: 'BODY', text: data.body }]), ts, ts);
  return mapRow(db.prepare('SELECT * FROM templates WHERE id = ?').get(id));
}

function update(id, userId, fields) {
  const db = getDb();
  const out = { ...fields };
  // metaStatus/metaId/components are owned by the sync job — refuse writes here.
  delete out.metaStatus; delete out.metaId; delete out.components;
  delete out.rejectedReason; delete out.syncedAt;
  if (out.body !== undefined) {
    out.variableCount = countVariables(out.body);
    out.components = fromJson([{ type: 'BODY', text: out.body }]);
  }
  const cols = Object.keys(out);
  if (!cols.length) return findForUser(id, userId);
  const set = cols.map(c => `${c} = ?`).join(', ');
  const res = db.prepare(`UPDATE templates SET ${set}, updatedAt = ? WHERE id = ? AND userId = ? AND isActive = 1`)
    .run(...cols.map(c => out[c]), now(), id, userId);
  if (res.changes === 0) return null;
  return findForUser(id, userId);
}

/*
 * Sync from Meta. For each template on the WABA, upsert by (name, language) —
 * Meta's own key. Local drafts that match a real template are adopted and
 * become sendable; everything else is inserted fresh.
 *
 * Returns { added, updated }.
 */
function upsertFromMeta(userId, accountId, metaTemplates) {
  const db = getDb();
  let added = 0, updated = 0;
  const ts = now();

  const run = db.transaction(() => {
    for (const t of metaTemplates) {
      if (!t.name) continue;
      const language = t.language || 'en';
      const components = t.components || [];
      const body = bodyFromComponents(components);
      const existing = db.prepare(
        'SELECT id FROM templates WHERE userId = ? AND name = ? AND language = ? AND isActive = 1')
        .get(userId, t.name, language);

      if (existing) {
        db.prepare(`UPDATE templates SET category = ?, body = ?, variableCount = ?, metaId = ?,
                    metaStatus = ?, rejectedReason = ?, components = ?, accountId = ?, status = ?,
                    syncedAt = ?, updatedAt = ? WHERE id = ?`)
          .run(categoryOrSafeDefault(t.category), body, countVariables(variableText(components, body)), t.id || '',
               (t.status || '').toUpperCase(), t.rejected_reason || '', fromJson(components),
               accountId, (t.status || '').toLowerCase(), ts, ts, existing.id);
        updated++;
      } else {
        db.prepare(`INSERT INTO templates (id,userId,name,category,language,body,status,variableCount,
                    metaId,metaStatus,rejectedReason,components,accountId,syncedAt,createdAt,updatedAt)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(newId(), userId, t.name, categoryOrSafeDefault(t.category), language, body,
               (t.status || '').toLowerCase(), countVariables(variableText(components, body)), t.id || '',
               (t.status || '').toUpperCase(), t.rejected_reason || '', fromJson(components),
               accountId, ts, ts, ts);
        added++;
      }
    }
  });
  run();
  return { added, updated };
}

function softDelete(id, userId) {
  const res = getDb().prepare('UPDATE templates SET isActive = 0, updatedAt = ? WHERE id = ? AND userId = ? AND isActive = 1')
    .run(now(), id, userId);
  return res.changes > 0;
}

module.exports = {
  listForUser, findForUser, findByNameLang, countForUser,
  create, update, upsertFromMeta, softDelete, mapRow,
  countVariables, SENDABLE_STATUS,
};
