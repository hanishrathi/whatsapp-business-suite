const express = require('express');
const router = express.Router();
const Contact = require('../models/Contact');
const { protect, requireVerified } = require('../middleware/auth');
const { logAction } = require('../utils/audit');

// GET /api/contacts — list this user's contacts (with simple search).
router.get('/', protect, async (req, res) => {
  try {
    const filter = { userId: req.user._id, isActive: true };
    if (req.query.q) {
      const rx = new RegExp(req.query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: rx }, { phone: rx }, { email: rx }];
    }
    const contacts = await Contact.find(filter).sort({ createdAt: -1 }).limit(500);
    const count = await Contact.countForUser(req.user._id);
    res.json({ success: true, contacts, count });
  } catch (err) {
    console.error('List contacts error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load contacts.' });
  }
});

// POST /api/contacts — create a contact.
router.post('/', protect, requireVerified, async (req, res) => {
  try {
    const { name, phone, email, tags, notes, accountId } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ success: false, message: 'Name and phone are required.' });
    }
    const existing = await Contact.findOne({ userId: req.user._id, phone, isActive: true });
    if (existing) {
      return res.status(409).json({ success: false, message: 'A contact with this phone already exists.' });
    }
    const contact = await Contact.create({
      userId: req.user._id,
      name: name.trim(),
      phone: phone.trim(),
      email: (email || '').trim(),
      tags: Array.isArray(tags) ? tags : (tags ? String(tags).split(',').map(t => t.trim()).filter(Boolean) : []),
      notes: notes || '',
      accountId: accountId || null,
    });
    await logAction(req, 'contact.create', { targetId: contact._id });
    res.status(201).json({ success: true, contact, message: 'Contact added.' });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ success: false, message: 'Contact already exists.' });
    console.error('Create contact error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to add contact.' });
  }
});

// PUT /api/contacts/:id — update a contact.
router.put('/:id', protect, requireVerified, async (req, res) => {
  try {
    const allowed = ['name', 'phone', 'email', 'tags', 'notes', 'status', 'accountId'];
    const updates = {};
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
    if (typeof updates.tags === 'string') {
      updates.tags = updates.tags.split(',').map(t => t.trim()).filter(Boolean);
    }
    const contact = await Contact.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id, isActive: true },
      updates, { new: true, runValidators: true }
    );
    if (!contact) return res.status(404).json({ success: false, message: 'Contact not found.' });
    res.json({ success: true, contact, message: 'Contact updated.' });
  } catch (err) {
    console.error('Update contact error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update contact.' });
  }
});

// DELETE /api/contacts/:id — soft delete.
router.delete('/:id', protect, requireVerified, async (req, res) => {
  try {
    const contact = await Contact.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id, isActive: true },
      { isActive: false }, { new: true }
    );
    if (!contact) return res.status(404).json({ success: false, message: 'Contact not found.' });
    await logAction(req, 'contact.delete', { targetId: contact._id });
    res.json({ success: true, message: 'Contact removed.' });
  } catch (err) {
    console.error('Delete contact error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to remove contact.' });
  }
});

module.exports = router;
