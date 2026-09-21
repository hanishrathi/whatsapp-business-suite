const express = require('express');
const router = express.Router();
const templates = require('../data/templates');
const waAccounts = require('../data/whatsappAccounts');
const wa = require('../utils/whatsapp');
const { protect, requireVerified } = require('../middleware/auth');
const { logAction } = require('../utils/audit');

/*
 * Templates live in Meta's WhatsApp Business Account. This app mirrors them.
 * A template can only be SENT if Meta has approved it, so approval status is
 * never settable here — it comes from POST /sync.
 */

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

/*
 * POST /api/templates/sync — mirror the approved templates from a WABA.
 *
 * This is the only way a template becomes sendable. Approval happens in Meta
 * Business Manager; the app cannot grant it.
 */
router.post('/sync', protect, requireVerified, async (req, res) => {
  try {
    const accountId = req.body.accountId;
    const account = accountId
      ? waAccounts.findForUserWithToken(accountId, req.user._id)
      : waAccounts.firstSendableForUser(req.user._id);

    if (!account) {
      return res.status(400).json({
        success: false,
        message: 'No Cloud API account to sync from. Add a WhatsApp account with its WABA ID, Phone Number ID and Access Token first.',
        code: 'NO_ACCOUNT',
      });
    }
    if (account.channelType === 'manual') {
      return res.status(400).json({
        success: false,
        message: `"${account.name}" is a WhatsApp Business app / regular WhatsApp number. Those have no template API — templates only exist for Cloud API accounts.`,
        code: 'MANUAL_CHANNEL',
      });
    }

    const r = await wa.listTemplates(account);
    if (!r.ok) return res.status(400).json({ success: false, message: `Template sync failed: ${r.error}`, code: r.code });

    const result = templates.upsertFromMeta(req.user._id, account._id, r.templates);
    const approved = r.templates.filter(t => String(t.status).toUpperCase() === 'APPROVED').length;
    logAction(req, 'template.sync', { meta: { ...result, total: r.templates.length } });

    res.json({
      success: true,
      added: result.added, updated: result.updated,
      total: r.templates.length, approved,
      message: `Synced ${r.templates.length} template${r.templates.length === 1 ? '' : 's'} from Meta (${approved} approved and ready to send).`,
    });
  } catch (err) {
    console.error('Sync templates error:', err.message);
    res.status(500).json({ success: false, message: 'Template sync failed.' });
  }
});

// PUT /api/templates/:id — edits the local draft only.
router.put('/:id', protect, requireVerified, (req, res) => {
  try {
    const allowed = ['name', 'category', 'language', 'body'];
    const updates = {};
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
    // Approval is Meta's to give. Reject attempts to set it rather than
    // silently dropping them, so nobody believes they approved a template.
    if (req.body.status !== undefined || req.body.metaStatus !== undefined) {
      return res.status(400).json({
        success: false,
        message: 'Template approval comes from Meta. Submit the template in Meta Business Manager, then use "Sync templates" to pull its status.',
        code: 'STATUS_NOT_SETTABLE',
      });
    }
    const existing = templates.findForUser(req.params.id, req.user._id);
    if (!existing) return res.status(404).json({ success: false, message: 'Template not found.' });
    // A template mirrored from Meta must match the WABA exactly — editing the
    // local copy would make sends fail with error 132000/132001.
    if (existing.metaId) {
      return res.status(409).json({
        success: false,
        message: 'This template is managed by Meta and cannot be edited here. Change it in Meta Business Manager, then sync.',
        code: 'META_MANAGED',
      });
    }
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
