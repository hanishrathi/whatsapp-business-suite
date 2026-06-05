const AuditLog = require('../models/AuditLog');

/*
 * Record a sensitive action. Never throws into the request flow —
 * an audit failure must not break the user's action, only be logged.
 *
 * Usage:  await logAction(req, 'whatsapp_account.delete', { targetId, meta });
 */
async function logAction(req, action, { targetId, meta } = {}) {
  try {
    await AuditLog.create({
      userId: req.user ? req.user._id : undefined,
      actorEmail: req.user ? req.user.email : undefined,
      action,
      targetId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta,
    });
  } catch (err) {
    // Audit must be best-effort; log a short note, never the full payload.
    console.error('Audit log write failed for action:', action);
  }
}

module.exports = { logAction };
