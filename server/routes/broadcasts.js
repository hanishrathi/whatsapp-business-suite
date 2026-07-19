const express = require('express');
const router = express.Router();
const broadcasts = require('../data/broadcasts');
const contacts = require('../data/contacts');
const templates = require('../data/templates');
const waAccounts = require('../data/whatsappAccounts');
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
    if (!name || (!message && !templateId)) {
      return res.status(400).json({ success: false, message: 'Name and a message or template are required.' });
    }
    const refErr = refsError(req.user._id, { templateId, accountId });
    if (refErr) return res.status(400).json({ success: false, message: refErr });
    const audienceCount = contacts.countAudience(req.user._id, audienceTag);
    const broadcast = broadcasts.create({
      userId: req.user._id, name, accountId, templateId, message,
      audienceTag: audienceTag || 'all', audienceCount, scheduledAt,
    });
    logAction(req, 'broadcast.create', { targetId: broadcast._id, meta: { audienceCount } });
    res.status(201).json({ success: true, broadcast, message: 'Broadcast created.' });
  } catch (err) {
    console.error('Create broadcast error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create broadcast.' });
  }
});

// PUT /api/broadcasts/:id
router.put('/:id', protect, requireVerified, (req, res) => {
  try {
    const allowed = ['name', 'accountId', 'templateId', 'message', 'audienceTag', 'status', 'scheduledAt'];
    const updates = {};
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
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
