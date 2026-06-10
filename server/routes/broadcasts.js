const express = require('express');
const router = express.Router();
const broadcasts = require('../data/broadcasts');
const contacts = require('../data/contacts');
const { protect, requireVerified } = require('../middleware/auth');
const { logAction } = require('../utils/audit');

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
