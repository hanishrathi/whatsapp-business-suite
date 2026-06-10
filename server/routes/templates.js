const express = require('express');
const router = express.Router();
const templates = require('../data/templates');
const { protect, requireVerified } = require('../middleware/auth');
const { logAction } = require('../utils/audit');

// GET /api/templates
router.get('/', protect, (req, res) => {
  try {
    const list = templates.listForUser(req.user._id);
    res.json({ success: true, templates: list, count: list.length });
  } catch (err) {
    console.error('List templates error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load templates.' });
  }
});

// POST /api/templates
router.post('/', protect, requireVerified, (req, res) => {
  try {
    const { name, body } = req.body;
    if (!name || !body) return res.status(400).json({ success: false, message: 'Template name and body are required.' });
    const template = templates.create({ ...req.body, userId: req.user._id });
    logAction(req, 'template.create', { targetId: template._id });
    res.status(201).json({ success: true, template, message: 'Template created.' });
  } catch (err) {
    console.error('Create template error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create template.' });
  }
});

// PUT /api/templates/:id
router.put('/:id', protect, requireVerified, (req, res) => {
  try {
    const allowed = ['name', 'category', 'language', 'body', 'status'];
    const updates = {};
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
    const template = templates.update(req.params.id, req.user._id, updates);
    if (!template) return res.status(404).json({ success: false, message: 'Template not found.' });
    res.json({ success: true, template, message: 'Template updated.' });
  } catch (err) {
    console.error('Update template error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update template.' });
  }
});

// DELETE /api/templates/:id
router.delete('/:id', protect, requireVerified, (req, res) => {
  try {
    const ok = templates.softDelete(req.params.id, req.user._id);
    if (!ok) return res.status(404).json({ success: false, message: 'Template not found.' });
    logAction(req, 'template.delete', { targetId: req.params.id });
    res.json({ success: true, message: 'Template deleted.' });
  } catch (err) {
    console.error('Delete template error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete template.' });
  }
});

module.exports = router;
