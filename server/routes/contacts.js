const express = require('express');
const router = express.Router();
const contacts = require('../data/contacts');
const waAccounts = require('../data/whatsappAccounts');
const { protect, requireVerified } = require('../middleware/auth');
const { logAction } = require('../utils/audit');

const CONTACT_STATUSES = ['active', 'inactive', 'blocked', 'unsubscribed'];

function badInput(body) {
  if (body.status !== undefined && !CONTACT_STATUSES.includes(body.status)) {
    return `Status must be one of: ${CONTACT_STATUSES.join(', ')}.`;
  }
  for (const k of ['name', 'phone', 'email', 'notes']) {
    if (body[k] !== undefined && typeof body[k] !== 'string') return `${k} must be text.`;
  }
  return null;
}

// GET /api/contacts
router.get('/', protect, (req, res) => {
  try {
    const list = contacts.listForUser(req.user._id, req.query.q);
    res.json({ success: true, contacts: list, count: contacts.countForUser(req.user._id) });
  } catch (err) {
    console.error('List contacts error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load contacts.' });
  }
});

// POST /api/contacts
router.post('/', protect, requireVerified, (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!name || !phone) return res.status(400).json({ success: false, message: 'Name and phone are required.' });
    const inputErr = badInput(req.body);
    if (inputErr) return res.status(400).json({ success: false, message: inputErr });
    if (req.body.accountId && !waAccounts.findForUser(req.body.accountId, req.user._id)) {
      return res.status(400).json({ success: false, message: 'WhatsApp account not found.' });
    }
    if (contacts.findActiveByPhone(req.user._id, phone)) {
      return res.status(409).json({ success: false, message: 'A contact with this phone already exists.' });
    }
    let contact;
    try {
      contact = contacts.create({ ...req.body, userId: req.user._id });
    } catch (err) {
      if (err.code === 11000) return res.status(409).json({ success: false, message: 'Contact already exists.' });
      throw err;
    }
    logAction(req, 'contact.create', { targetId: contact._id });
    res.status(201).json({ success: true, contact, message: 'Contact added.' });
  } catch (err) {
    console.error('Create contact error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to add contact.' });
  }
});

// PUT /api/contacts/:id
router.put('/:id', protect, requireVerified, (req, res) => {
  try {
    const allowed = ['name', 'phone', 'email', 'tags', 'notes', 'status', 'accountId'];
    const updates = {};
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
    const inputErr = badInput(updates);
    if (inputErr) return res.status(400).json({ success: false, message: inputErr });
    if (updates.accountId && !waAccounts.findForUser(updates.accountId, req.user._id)) {
      return res.status(400).json({ success: false, message: 'WhatsApp account not found.' });
    }
    const contact = contacts.update(req.params.id, req.user._id, updates);
    if (!contact) return res.status(404).json({ success: false, message: 'Contact not found.' });
    res.json({ success: true, contact, message: 'Contact updated.' });
  } catch (err) {
    console.error('Update contact error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update contact.' });
  }
});

// DELETE /api/contacts/:id
router.delete('/:id', protect, requireVerified, (req, res) => {
  try {
    const ok = contacts.softDelete(req.params.id, req.user._id);
    if (!ok) return res.status(404).json({ success: false, message: 'Contact not found.' });
    logAction(req, 'contact.delete', { targetId: req.params.id });
    res.json({ success: true, message: 'Contact removed.' });
  } catch (err) {
    console.error('Delete contact error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to remove contact.' });
  }
});

module.exports = router;
