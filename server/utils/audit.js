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

/*
 * Record an action that has no HTTP request behind it — a webhook from Meta,
 * a scheduled send. Consent changes especially must be auditable: if a contact
 * opts out by replying STOP, the record of that has to survive.
 *
 * Usage:  logSystemAction('contact.opt_out', { userId, targetId, meta });
 */
function logSystemAction(action, { userId, targetId, meta } = {}) {
  try {
    auditLogs.create({
      userId,
      actorEmail: 'system',
      action,
      targetId,
      ip: null,
      userAgent: 'whatsapp-webhook',
      meta,
    });
  } catch (err) {
    console.error('Audit log write failed for system action:', action);
  }
}

module.exports = { logAction, logSystemAction };
