const express = require('express');
const router = express.Router();
const broadcasts = require('../data/broadcasts');
const contacts = require('../data/contacts');
const templates = require('../data/templates');
const waAccounts = require('../data/whatsappAccounts');
const bmsgs = require('../data/broadcastMessages');
const sender = require('../services/sender');
const { protect, requireVerified } = require('../middleware/auth');
const { logAction } = require('../utils/audit');

// Statuses a user may set directly; sent/completed are reserved for the send engine.
const SETTABLE_STATUSES = ['draft', 'scheduled', 'paused', 'cancelled'];

// A referenced template/account must belong to the caller.
function refsError(userId, { templateId, accountId }) {
  if (templateId && !templates.findForUser(templateId, userId)) return 'Template not found.';
  if (accountId && !waAccounts.findForUser(accountId, userId)) return 'WhatsApp account not found.';
  return null;
}

/*
 * A broadcast is business-initiated, so WhatsApp requires an approved template.
 * Free-form text is only allowed as a reply inside the 24-hour customer service
 * window a contact opens by messaging you — which is per-conversation, not a
 * broadcast. The one exception is a manual channel, where the operator types
 * the message into their own WhatsApp app and this app only supplies the text.
 */
function requiresTemplate(userId, accountId) {
  if (!accountId) return true;
  const account = waAccounts.findForUser(accountId, userId);
  return !account || account.channelType !== 'manual';
}

// GET /api/broadcasts
router.get('/', protect, (req, res) => {
  try {
    const list = broadcasts.listForUser(req.user._id);
    res.json({ success: true, broadcasts: list, count: list.length });
  } catch (err) {
    console.error('List broadcasts error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load broadcasts.' });
  }
});

// POST /api/broadcasts
router.post('/', protect, requireVerified, (req, res) => {
  try {
    const { name, templateId, message, audienceTag, accountId, scheduledAt } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Broadcast name is required.' });

    const refErr = refsError(req.user._id, { templateId, accountId });
    if (refErr) return res.status(400).json({ success: false, message: refErr });

    const needsTemplate = requiresTemplate(req.user._id, accountId);
    if (needsTemplate && !templateId) {
      return res.status(400).json({
        success: false,
        message: 'Pick an approved WhatsApp template. Business-initiated messages must use a template — free-form text can only be sent as a reply within 24 hours of a customer messaging you.',
        code: 'TEMPLATE_REQUIRED',
      });
    }
    if (!needsTemplate && !message && !templateId) {
      return res.status(400).json({ success: false, message: 'Enter the message text to hand off to your WhatsApp app.' });
    }
    // Warn early rather than at send time if the chosen template isn't approved.
    let category = null;
    if (templateId) {
      const t = templates.findForUser(templateId, req.user._id);
      if (needsTemplate && t && !t.isSendable) {
        return res.status(400).json({
          success: false,
          message: `Template "${t.name}" is not approved by Meta (status: ${t.metaStatus || 'not synced'}). Sync templates, or submit it in Meta Business Manager first.`,
          code: 'TEMPLATE_NOT_APPROVED',
        });
      }
      if (t) category = (t.category || 'marketing').toLowerCase();
    }

    /*
     * Count the audience the way the sender will select it: a MARKETING
     * template also skips anyone who opted out of marketing specifically, so
     * counting without the category would promise more recipients than the
     * send delivers.
     */
    const audienceCount = contacts.countAudience(req.user._id, audienceTag, category);
    const excluded = contacts.countExcludedFromAudience(req.user._id, audienceTag, category);
    const broadcast = broadcasts.create({
      userId: req.user._id, name, accountId, templateId, message,
      audienceTag: audienceTag || 'all', audienceCount, scheduledAt,
    });
    logAction(req, 'broadcast.create', { targetId: broadcast._id, meta: { audienceCount } });
    res.status(201).json({
      success: true, broadcast, audienceCount, excluded,
      message: excluded
        ? `Broadcast created for ${audienceCount} opted-in contact${audienceCount === 1 ? '' : 's'}. ${excluded} excluded for missing consent, opt-out or inactive status.`
        : 'Broadcast created.',
    });
  } catch (err) {
    console.error('Create broadcast error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create broadcast.' });
  }
});

// GET /api/broadcasts/:id — one broadcast + live per-recipient counts (for progress polling)
router.get('/:id', protect, (req, res) => {
  try {
    const broadcast = broadcasts.findForUser(req.params.id, req.user._id);
    if (!broadcast) return res.status(404).json({ success: false, message: 'Broadcast not found.' });
    res.json({ success: true, broadcast, counts: bmsgs.countsForBroadcast(broadcast._id) });
  } catch (err) {
    console.error('Get broadcast error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load broadcast.' });
  }
});

// POST /api/broadcasts/:id/send — actually deliver it via the WhatsApp Cloud API
router.post('/:id/send', protect, requireVerified, (req, res) => {
  try {
    const r = sender.sendNow(req.params.id, req.user._id);
    if (r.error) {
      const status = r.code === 'NOT_FOUND' ? 404 : 400;
      return res.status(status).json({ success: false, message: r.error, code: r.code });
    }
    logAction(req, 'broadcast.send', { targetId: req.params.id, meta: { audienceCount: r.audienceCount } });
    res.status(202).json({ success: true, message: `Sending to ${r.audienceCount} contacts…`, audienceCount: r.audienceCount });
  } catch (err) {
    console.error('Send broadcast error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to start sending.' });
  }
});

/*
 * POST /api/broadcasts/:id/retry — resend to recipients that failed for a
 * transient reason. Permanent failures are skipped deliberately.
 */
router.post('/:id/retry', protect, requireVerified, (req, res) => {
  try {
    const r = sender.retryFailed(req.params.id, req.user._id);
    if (r.error) {
      const status = r.code === 'NOT_FOUND' ? 404 : 400;
      return res.status(status).json({ success: false, message: r.error, code: r.code });
    }
    logAction(req, 'broadcast.retry', { targetId: req.params.id, meta: { count: r.retryCount } });
    res.status(202).json({
      success: true, retryCount: r.retryCount,
      message: `Retrying ${r.retryCount} failed recipient${r.retryCount === 1 ? '' : 's'}…`,
    });
  } catch (err) {
    console.error('Retry broadcast error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to start retry.' });
  }
});

/*
 * GET /api/broadcasts/:id/handoff — click-to-chat links for a manual channel.
 *
 * Meta publishes no API for the WhatsApp Business app or regular WhatsApp, so
 * the compliant way to use those numbers is for the operator to send each
 * message themselves. This returns one wa.me link per opted-in recipient with
 * the personalised text pre-filled.
 */
router.get('/:id/handoff', protect, requireVerified, (req, res) => {
  try {
    const r = sender.buildHandoffLinks(req.params.id, req.user._id);
    if (r.error) {
      const status = r.code === 'NOT_FOUND' ? 404 : 400;
      return res.status(status).json({ success: false, message: r.error, code: r.code });
    }
    logAction(req, 'broadcast.handoff', { targetId: req.params.id, meta: { count: r.links.length } });
    res.json({
      success: true, links: r.links, count: r.links.length,
      message: `${r.links.length} chat link${r.links.length === 1 ? '' : 's'} ready. Opening each one sends from whichever WhatsApp app is installed on your device.`,
    });
  } catch (err) {
    console.error('Broadcast handoff error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to build chat links.' });
  }
});

// PUT /api/broadcasts/:id
router.put('/:id', protect, requireVerified, (req, res) => {
  try {
    const allowed = ['name', 'accountId', 'templateId', 'message', 'audienceTag', 'status', 'scheduledAt'];
    const updates = {};
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
    const current = broadcasts.findForUser(req.params.id, req.user._id);
    if (!current) return res.status(404).json({ success: false, message: 'Broadcast not found.' });
    if (current.status === 'sending') {
      return res.status(409).json({ success: false, message: 'Cannot edit a broadcast while it is sending.' });
    }
    if (updates.status !== undefined && !SETTABLE_STATUSES.includes(updates.status)) {
      return res.status(400).json({ success: false, message: `Status must be one of: ${SETTABLE_STATUSES.join(', ')}.` });
    }
    const refErr = refsError(req.user._id, updates);
    if (refErr) return res.status(400).json({ success: false, message: refErr });
    const broadcast = broadcasts.update(req.params.id, req.user._id, updates);
    if (!broadcast) return res.status(404).json({ success: false, message: 'Broadcast not found.' });
    res.json({ success: true, broadcast, message: 'Broadcast updated.' });
  } catch (err) {
    console.error('Update broadcast error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update broadcast.' });
  }
});

// DELETE /api/broadcasts/:id
router.delete('/:id', protect, requireVerified, (req, res) => {
  try {
    const ok = broadcasts.softDelete(req.params.id, req.user._id);
    if (!ok) return res.status(404).json({ success: false, message: 'Broadcast not found.' });
    logAction(req, 'broadcast.delete', { targetId: req.params.id });
    res.json({ success: true, message: 'Broadcast deleted.' });
  } catch (err) {
    console.error('Delete broadcast error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete broadcast.' });
  }
});

module.exports = router;
