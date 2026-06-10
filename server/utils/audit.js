const auditLogs = require('../data/auditLogs');

/*
 * Record a sensitive action. Never throws into the request flow —
 * an audit failure must not break the user's action, only be logged.
 *
 * Usage:  logAction(req, 'whatsapp_account.delete', { targetId, meta });
 */
function logAction(req, action, { targetId, meta } = {}) {
  try {
    auditLogs.create({
      userId: req.user ? req.user._id : undefined,
      actorEmail: req.user ? req.user.email : undefined,
      action,
      targetId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta,
    });
  } catch (err) {
    console.error('Audit log write failed for action:', action);
  }
}

module.exports = { logAction };
