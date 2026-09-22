const { getDb, newId } = require('../config/database');
const { SERVICE_WINDOW_MS } = require('./_constants');
const { toBool, toDate, toJson, fromJson, fromDate, now } = require('./_map');


function mapRow(row) {
  if (!row) return null;
  const optInAt = toDate(row.optInAt);
  const optOutAt = toDate(row.optOutAt);
  const lastInboundAt = toDate(row.lastInboundAt);
  return {
    _id: row.id, id: row.id, userId: row.userId,
    name: row.name, phone: row.phone, email: row.email || '',
    tags: toJson(row.tags, []), notes: row.notes || '',
    accountId: row.accountId || null, status: row.status,
    lastContacted: toDate(row.lastContacted), isActive: toBool(row.isActive),
    // Consent state — required before any business-initiated message.
    optInAt, optInSource: row.optInSource || '',
    optOutAt, optOutReason: row.optOutReason || '',
    marketingOptOutAt: toDate(row.marketingOptOutAt),
    hasOptIn: !!optInAt && !optOutAt,
    // Marketing needs consent that has not been withdrawn for marketing either.
    acceptsMarketing: !!optInAt && !optOutAt && !row.marketingOptOutAt,
    // Service window state.
    lastInboundAt,
    serviceWindowOpen: !!lastInboundAt && (Date.now() - lastInboundAt.getTime()) < SERVICE_WINDOW_MS,
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
function findByIdForUser(id, userId) {
  return mapRow(getDb().prepare('SELECT * FROM contacts WHERE id = ? AND userId = ? AND isActive = 1').get(id, userId));
}

function findActiveByPhone(userId, phone) {
  return mapRow(getDb().prepare('SELECT * FROM contacts WHERE userId = ? AND phone = ? AND isActive = 1').get(userId, phone));
}

/*
 * Webhook path: Meta reports the sender as digits only ("919876543210") while
 * stored contacts may be formatted ("+91 98765 43210").
 *
 * Tries the indexed exact forms first — which covers how this app stores
 * numbers — and only falls back to a digit-by-digit comparison for contacts
 * imported in some other format. The fallback is bounded so a burst of inbound
 * webhooks cannot turn into a full table scan per message.
 */
const DIGIT_SCAN_LIMIT = 2000;

function findActiveByDigits(userId, digits) {
  const target = String(digits || '').replace(/[^\d]/g, '');
  if (!target) return null;
  const db = getDb();

  // Indexed hit on the two spellings this app writes.
  const direct = db.prepare(
    `SELECT * FROM contacts WHERE userId = ? AND isActive = 1 AND phone IN (?, ?) LIMIT 1`)
    .get(userId, '+' + target, target);
  if (direct) return mapRow(direct);

  // Legacy/odd formatting: compare on digits, newest first, bounded.
  const rows = db.prepare(
    `SELECT * FROM contacts WHERE userId = ? AND isActive = 1 ORDER BY createdAt DESC LIMIT ?`)
    .all(userId, DIGIT_SCAN_LIMIT);
  const hit = rows.find(r => String(r.phone).replace(/[^\d]/g, '') === target);
  return hit ? mapRow(hit) : null;
}
function countForUser(userId) {
  return getDb().prepare('SELECT COUNT(*) c FROM contacts WHERE userId = ? AND isActive = 1').get(userId).c;
}
/*
 * Broadcast audience.
 *
 * WhatsApp only permits business-initiated messages to people who have opted
 * in, and requires opt-outs to be honoured. Both rules are enforced here, in
 * the query, so there is no code path that can blast a non-consenting contact:
 *   - optInAt must be set
 *   - optOutAt must be null
 *   - status must be 'active' (excludes inactive/blocked/unsubscribed)
 */
const AUDIENCE_WHERE =
  `userId = ? AND isActive = 1 AND status = 'active' AND optInAt IS NOT NULL AND optOutAt IS NULL`;

/*
 * A MARKETING template additionally requires that marketing consent has not
 * been withdrawn. Utility and authentication messages still reach someone who
 * only opted out of promotions.
 */
function categoryClause(category) {
  return String(category || '').toLowerCase() === 'marketing'
    ? ' AND marketingOptOutAt IS NULL' : '';
}

function countAudience(userId, tag, category) {
  const db = getDb();
  const extra = categoryClause(category);
  if (!tag || tag === 'all') {
    return db.prepare(`SELECT COUNT(*) c FROM contacts WHERE ${AUDIENCE_WHERE}${extra}`).get(userId).c;
  }
  return db.prepare(`SELECT COUNT(*) c FROM contacts WHERE ${AUDIENCE_WHERE}${extra} AND tags LIKE ?`)
    .get(userId, `%"${tag}"%`).c;
}

// Full audience rows for an actual send (bigger cap than the UI list).
function listAudience(userId, tag, limit = 5000, category) {
  const db = getDb();
  const extra = categoryClause(category);
  if (!tag || tag === 'all') {
    return db.prepare(`SELECT * FROM contacts WHERE ${AUDIENCE_WHERE}${extra} ORDER BY createdAt LIMIT ?`)
      .all(userId, limit).map(mapRow);
  }
  return db.prepare(`SELECT * FROM contacts WHERE ${AUDIENCE_WHERE}${extra} AND tags LIKE ? ORDER BY createdAt LIMIT ?`)
    .all(userId, `%"${tag}"%`, limit).map(mapRow);
}

/*
 * How many contacts match the tag but are excluded for consent reasons — shown
 * to the user before a send so the audience count is never silently smaller
 * than they expect.
 */
function countExcludedFromAudience(userId, tag, category) {
  const db = getDb();
  // For a marketing send, a marketing opt-out is also a reason to be excluded.
  const marketing = String(category || '').toLowerCase() === 'marketing'
    ? ' OR marketingOptOutAt IS NOT NULL' : '';
  const base = `userId = ? AND isActive = 1 AND (optInAt IS NULL OR optOutAt IS NOT NULL OR status != 'active'${marketing})`;
  if (!tag || tag === 'all') {
    return db.prepare(`SELECT COUNT(*) c FROM contacts WHERE ${base}`).get(userId).c;
  }
  return db.prepare(`SELECT COUNT(*) c FROM contacts WHERE ${base} AND tags LIKE ?`)
    .get(userId, `%"${tag}"%`).c;
}

/* ---------- consent + inbound tracking ---------- */

/*
 * Record opt-in. `source` is free text describing HOW consent was obtained —
 * Meta expects businesses to be able to demonstrate this.
 *
 * This also lifts an earlier opt-out, including the 'unsubscribed' status and
 * any marketing-only withdrawal. Clearing optOutAt alone left the contact
 * excluded by the audience query, so someone who texted STOP and then START
 * was never actually resubscribed — the platform requires honouring that.
 * Statuses other than 'unsubscribed' (blocked, inactive) are deliberate
 * operator choices and are left alone.
 */
function recordOptIn(id, userId, source) {
  const res = getDb().prepare(
    `UPDATE contacts SET optInAt = ?, optInSource = ?, optOutAt = NULL, optOutReason = '',
                         marketingOptOutAt = NULL,
                         status = CASE WHEN status = 'unsubscribed' THEN 'active' ELSE status END,
                         updatedAt = ?
     WHERE id = ? AND userId = ? AND isActive = 1`)
    .run(now(), String(source || 'manual').slice(0, 200), now(), id, userId);
  return res.changes > 0;
}

// Record opt-out and flip the contact to 'unsubscribed' so it leaves every audience.
function recordOptOut(id, userId, reason) {
  const res = getDb().prepare(
    `UPDATE contacts SET optOutAt = ?, optOutReason = ?, status = 'unsubscribed', updatedAt = ?
     WHERE id = ? AND userId = ? AND isActive = 1`)
    .run(now(), String(reason || '').slice(0, 200), now(), id, userId);
  return res.changes > 0;
}

/*
 * Record opt-in for every contact that has none yet.
 *
 * This exists for the upgrade path: contacts added before consent was tracked
 * have no opt-in record, so they would silently drop out of every audience.
 * The caller must still state where that consent came from — it is a
 * declaration about contacts they already had, not a way to skip the rule.
 * Contacts who have opted OUT are never revived by this.
 */
function bulkRecordOptIn(userId, source) {
  const res = getDb().prepare(
    `UPDATE contacts SET optInAt = ?, optInSource = ?, updatedAt = ?
     WHERE userId = ? AND isActive = 1 AND optInAt IS NULL AND optOutAt IS NULL`)
    .run(now(), String(source || '').slice(0, 200), now(), userId);
  return res.changes;
}

function countWithoutConsent(userId) {
  return getDb().prepare(
    `SELECT COUNT(*) c FROM contacts WHERE userId = ? AND isActive = 1 AND optInAt IS NULL AND optOutAt IS NULL`)
    .get(userId).c;
}

/*
 * Marketing-only opt-out: stops promotional templates but leaves utility and
 * authentication messages (order updates, OTPs) flowing. The contact stays
 * 'active' because they have not withdrawn consent entirely.
 */
function recordMarketingOptOut(id, userId) {
  const res = getDb().prepare(
    `UPDATE contacts SET marketingOptOutAt = ?, updatedAt = ? WHERE id = ? AND userId = ? AND isActive = 1`)
    .run(now(), now(), id, userId);
  return res.changes > 0;
}

// Webhook path: an inbound message opens/extends the 24h service window.
function touchInbound(id, userId) {
  getDb().prepare(`UPDATE contacts SET lastInboundAt = ?, updatedAt = ? WHERE id = ? AND userId = ? AND isActive = 1`)
    .run(now(), now(), id, userId);
}

// All active contacts for CSV export (any status).
function listForExport(userId, limit = 20000) {
  return getDb().prepare('SELECT * FROM contacts WHERE userId = ? AND isActive = 1 ORDER BY createdAt LIMIT ?')
    .all(userId, limit).map(mapRow);
}

/*
 * Bulk import. One transaction; invalid rows and duplicates are skipped.
 *
 * `optInSource` applies to the whole file: the importer must declare where
 * consent for this list came from. Rows imported without it land with no
 * opt-in and are excluded from every broadcast audience until someone
 * records consent for them.
 */
function bulkCreate(userId, rows, optInSource) {
  const db = getDb();
  let added = 0, skipped = 0, invalidPhone = 0;
  const errors = [];
  const { isValidE164 } = require('../utils/whatsapp');
  const run = db.transaction(() => {
    for (const r of rows) {
      const name = typeof r.name === 'string' ? r.name.trim() : '';
      const phone = typeof r.phone === 'string' || typeof r.phone === 'number' ? String(r.phone).trim() : '';
      if (!name || !phone) { skipped++; continue; }
      // Reject numbers that can never be delivered rather than failing per-send later.
      if (!isValidE164(phone)) { invalidPhone++; skipped++; continue; }
      try {
        create({
          userId, name, phone,
          email: typeof r.email === 'string' ? r.email : '',
          tags: r.tags, notes: typeof r.notes === 'string' ? r.notes : '',
          optInSource,
        });
        added++;
      } catch (err) {
        skipped++;
        if (err.code !== 11000 && errors.length < 5) errors.push(err.message);
      }
    }
  });
  run();
  return { added, skipped, invalidPhone, errors };
}

function create(data) {
  const db = getDb();
  const id = newId();
  const ts = now();
  const tags = Array.isArray(data.tags) ? data.tags
    : (data.tags ? String(data.tags).split(',').map(t => t.trim()).filter(Boolean) : []);
  // Opt-in is never assumed. A contact is only marked consenting when the
  // caller explicitly says so and describes where the consent came from.
  const optInAt = data.optInSource ? ts : null;
  try {
    db.prepare(`INSERT INTO contacts (id,userId,name,phone,email,tags,notes,accountId,optInAt,optInSource,createdAt,updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, data.userId, data.name.trim(), String(data.phone).trim(), (data.email || '').trim(),
      fromJson(tags), data.notes || '', data.accountId || null,
      optInAt, String(data.optInSource || '').slice(0, 200), ts, ts);
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

module.exports = {
  listForUser, listAudience, listForExport, bulkCreate,
  findActiveByPhone, findActiveByDigits, findByIdForUser,
  countForUser, countAudience, countExcludedFromAudience,
  recordOptIn, recordOptOut, recordMarketingOptOut, bulkRecordOptIn, countWithoutConsent, touchInbound,
  create, update, softDelete, mapRow,
  SERVICE_WINDOW_MS,
};
