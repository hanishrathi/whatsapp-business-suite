const express = require('express');
const router = express.Router();
const Broadcast = require('../models/Broadcast');
const Contact = require('../models/Contact');
const { protect, requireVerified } = require('../middleware/auth');
const { logAction } = require('../utils/audit');

// GET /api/broadcasts — list this user's broadcasts.
router.get('/', protect, async (req, res) => {
  try {
    const broadcasts = await Broadcast.find({ userId: req.user._id, isActive: true }).sort({ createdAt: -1 });
    res.json({ success: true, broadcasts, count: broadcasts.length });
  } catch (err) {
    console.error('List broadcasts error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load broadcasts.' });
  }
});

// POST /api/broadcasts — create a broadcast (draft or scheduled).
router.post('/', protect, requireVerified, async (req, res) => {
  try {
    const { name, accountId, templateId, message, audienceTag, scheduledAt } = req.body;
    if (!name || (!message && !templateId)) {
      return res.status(400).json({ success: false, message: 'Name and a message or template are required.' });
    }

    // Compute audience size from the user's contacts.
    const audienceFilter = { userId: req.user._id, isActive: true, status: 'active' };
    if (audienceTag && audienceTag !== 'all') audienceFilter.tags = audienceTag;
    const audienceCount = await Contact.countDocuments(audienceFilter);

    const broadcast = await Broadcast.create({
      userId: req.user._id,
      name: name.trim(),
      accountId: accountId || null,
      templateId: templateId || null,
      message: message || '',
      audienceTag: audienceTag || 'all',
      audienceCount,
      status: scheduledAt ? 'scheduled' : 'draft',
      scheduledAt: scheduledAt || null,
    });
    await logAction(req, 'broadcast.create', { targetId: broadcast._id, meta: { audienceCount } });
    res.status(201).json({ success: true, broadcast, message: 'Broadcast created.' });
  } catch (err) {
    console.error('Create broadcast error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create broadcast.' });
  }
});

// PUT /api/broadcasts/:id — update a broadcast.
router.put('/:id', protect, requireVerified, async (req, res) => {
  try {
    const allowed = ['name', 'accountId', 'templateId', 'message', 'audienceTag', 'status', 'scheduledAt'];
    const updates = {};
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
    const broadcast = await Broadcast.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id, isActive: true },
      updates, { new: true, runValidators: true }
    );
    if (!broadcast) return res.status(404).json({ success: false, message: 'Broadcast not found.' });
    res.json({ success: true, broadcast, message: 'Broadcast updated.' });
  } catch (err) {
    console.error('Update broadcast error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update broadcast.' });
  }
});

// DELETE /api/broadcasts/:id — soft delete.
router.delete('/:id', protect, requireVerified, async (req, res) => {
  try {
    const broadcast = await Broadcast.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id, isActive: true },
      { isActive: false }, { new: true }
    );
    if (!broadcast) return res.status(404).json({ success: false, message: 'Broadcast not found.' });
    await logAction(req, 'broadcast.delete', { targetId: broadcast._id });
    res.json({ success: true, message: 'Broadcast deleted.' });
  } catch (err) {
    console.error('Delete broadcast error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete broadcast.' });
  }
});

module.exports = router;
