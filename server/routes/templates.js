const express = require('express');
const router = express.Router();
const Template = require('../models/Template');
const { protect, requireVerified } = require('../middleware/auth');
const { logAction } = require('../utils/audit');

// GET /api/templates — list this user's templates.
router.get('/', protect, async (req, res) => {
  try {
    const templates = await Template.find({ userId: req.user._id, isActive: true }).sort({ createdAt: -1 });
    res.json({ success: true, templates, count: templates.length });
  } catch (err) {
    console.error('List templates error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load templates.' });
  }
});

// POST /api/templates — create a template.
router.post('/', protect, requireVerified, async (req, res) => {
  try {
    const { name, category, language, body } = req.body;
    if (!name || !body) {
      return res.status(400).json({ success: false, message: 'Template name and body are required.' });
    }
    const template = await Template.create({
      userId: req.user._id,
      name: name.trim(),
      category: category || 'marketing',
      language: language || 'en',
      body,
      status: 'draft',
    });
    await logAction(req, 'template.create', { targetId: template._id });
    res.status(201).json({ success: true, template, message: 'Template created.' });
  } catch (err) {
    console.error('Create template error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create template.' });
  }
});

// PUT /api/templates/:id — update a template.
router.put('/:id', protect, requireVerified, async (req, res) => {
  try {
    const allowed = ['name', 'category', 'language', 'body', 'status'];
    const template = await Template.findOne({ _id: req.params.id, userId: req.user._id, isActive: true });
    if (!template) return res.status(404).json({ success: false, message: 'Template not found.' });
    for (const k of allowed) if (req.body[k] !== undefined) template[k] = req.body[k];
    await template.save(); // triggers variableCount recount
    res.json({ success: true, template, message: 'Template updated.' });
  } catch (err) {
    console.error('Update template error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update template.' });
  }
});

// DELETE /api/templates/:id — soft delete.
router.delete('/:id', protect, requireVerified, async (req, res) => {
  try {
    const template = await Template.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id, isActive: true },
      { isActive: false }, { new: true }
    );
    if (!template) return res.status(404).json({ success: false, message: 'Template not found.' });
    await logAction(req, 'template.delete', { targetId: template._id });
    res.json({ success: true, message: 'Template deleted.' });
  } catch (err) {
    console.error('Delete template error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete template.' });
  }
});

module.exports = router;
