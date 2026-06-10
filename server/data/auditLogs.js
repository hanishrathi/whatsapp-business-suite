const { getDb, newId } = require('../config/database');
const { fromJson, now } = require('./_map');

// Append-only audit record.
function create({ userId, actorEmail, action, targetId, ip, userAgent, meta }) {
  getDb().prepare(`INSERT INTO audit_logs (id,userId,actorEmail,action,targetId,ip,userAgent,meta,createdAt)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    newId(), userId || null, actorEmail || null, action,
    targetId || null, ip || null, userAgent || null,
    meta ? fromJson(meta) : null, now());
}

module.exports = { create };
