const express = require('express');
const router = express.Router();
const contacts = require('../data/contacts');
const waAccounts = require('../data/whatsappAccounts');
const { protect, requireVerified } = require('../middleware/auth');
const { logAction } = require('../utils/audit');
const { isValidE164 } = require('../utils/whatsapp');

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

/*
 * POST /api/contacts/import — bulk rows [{name, phone, email?, tags?, notes?}]
 *
 * `optInSource` describes how consent was obtained for this whole list (e.g.
 * "website signup form, Jan 2026"). WhatsApp requires demonstrable opt-in
 * before any business-initiated message, so it is mandatory when the caller
 * wants the imported contacts to be messageable. Importing without it is
 * allowed but the contacts land unconsenting and no broadcast will reach them.
 */
router.post('/import', protect, requireVerified, (req, res) => {
  try {
    const rows = req.body.contacts;
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ success: false, message: 'Send a "contacts" array with name and phone for each row.' });
    }
    if (rows.length > 500) {
      return res.status(400).json({ success: false, message: 'Maximum 500 contacts per import request.' });
    }
    const optInSource = typeof req.body.optInSource === 'string' ? req.body.optInSource.trim() : '';
    const result = contacts.bulkCreate(req.user._id, rows, optInSource);
    logAction(req, 'contact.import', {
      meta: { added: result.added, skipped: result.skipped, optInSource: optInSource || null },
    });

    const parts = [];
    if (result.skipped) {
      parts.push(`skipped ${result.skipped}`
        + (result.invalidPhone ? ` (${result.invalidPhone} with an unusable phone number)` : ' (duplicates or missing name/phone)'));
    }
    if (!optInSource && result.added) {
      parts.push('none are marked as opted in, so broadcasts will not reach them — record consent to enable messaging');
    }
    res.json({
      success: true, added: result.added, skipped: result.skipped,
      invalidPhone: result.invalidPhone, optInRecorded: !!optInSource,
      message: `Imported ${result.added} contact${result.added === 1 ? '' : 's'}${parts.length ? `; ${parts.join('; ')}` : ''}.`,
    });
  } catch (err) {
    console.error('Import contacts error:', err.message);
    res.status(500).json({ success: false, message: 'Import failed.' });
  }
});

// POST /api/contacts/:id/opt-in — record consent
router.post('/:id/opt-in', protect, requireVerified, (req, res) => {
  try {
    const source = typeof req.body.source === 'string' ? req.body.source.trim() : '';
    if (!source) {
      return res.status(400).json({
        success: false,
        message: 'Describe where consent came from (e.g. "checkout form", "signed contract"). WhatsApp requires businesses to be able to demonstrate opt-in.',
      });
    }
    if (!contacts.recordOptIn(req.params.id, req.user._id, source)) {
      return res.status(404).json({ success: false, message: 'Contact not found.' });
    }
    logAction(req, 'contact.opt_in', { targetId: req.params.id, meta: { source } });
    res.json({ success: true, message: 'Opt-in recorded. This contact can now receive broadcasts.' });
  } catch (err) {
    console.error('Opt-in error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to record opt-in.' });
  }
});

/*
 * POST /api/contacts/opt-in-existing — record consent for contacts that predate
 * consent tracking, so an upgrade doesn't silently empty every audience.
 * Declaring the source is still required, and opted-out contacts stay out.
 */
router.post('/opt-in-existing', protect, requireVerified, (req, res) => {
  try {
    const source = typeof req.body.source === 'string' ? req.body.source.trim() : '';
    if (!source) {
      return res.status(400).json({
        success: false,
        message: 'Describe where consent for these existing contacts came from (e.g. "opt-in checkbox on our signup form since 2024"). You must be able to demonstrate it if Meta asks.',
      });
    }
    const pending = contacts.countWithoutConsent(req.user._id);
    const updated = contacts.bulkRecordOptIn(req.user._id, source);
    logAction(req, 'contact.bulk_opt_in', { meta: { count: updated, source } });
    res.json({
      success: true, updated, pending,
      message: updated
        ? `Recorded opt-in for ${updated} existing contact${updated === 1 ? '' : 's'}.`
        : 'No contacts were missing a consent record.',
    });
  } catch (err) {
    console.error('Bulk opt-in error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to record opt-in.' });
  }
});

// POST /api/contacts/:id/opt-out — honour an unsubscribe request
router.post('/:id/opt-out', protect, requireVerified, (req, res) => {
  try {
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : 'Manual';
    if (!contacts.recordOptOut(req.params.id, req.user._id, reason)) {
      return res.status(404).json({ success: false, message: 'Contact not found.' });
    }
    logAction(req, 'contact.opt_out', { targetId: req.params.id, meta: { reason } });
    res.json({ success: true, message: 'Opt-out recorded. This contact is excluded from all broadcasts.' });
  } catch (err) {
    console.error('Opt-out error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to record opt-out.' });
  }
});

// GET /api/contacts/export — download all contacts as CSV
router.get('/export', protect, (req, res) => {
  try {
    const list = contacts.listForExport(req.user._id);
    const csvCell = v => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    // Consent columns are exported too — the opt-in record is the evidence a
    // business needs if Meta or a regulator asks.
    const lines = ['name,phone,email,tags,status,optInAt,optInSource,optOutAt,notes'];
    const iso = d => (d ? new Date(d).toISOString() : '');
    for (const c of list) {
      lines.push([
        c.name, c.phone, c.email, (c.tags || []).join('|'), c.status,
        iso(c.optInAt), c.optInSource, iso(c.optOutAt), c.notes,
      ].map(csvCell).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
    res.send(lines.join('\n'));
  } catch (err) {
    console.error('Export contacts error:', err.message);
    res.status(500).json({ success: false, message: 'Export failed.' });
  }
});

// POST /api/contacts
router.post('/', protect, requireVerified, (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!name || !phone) return res.status(400).json({ success: false, message: 'Name and phone are required.' });
    const inputErr = badInput(req.body);
    if (inputErr) return res.status(400).json({ success: false, message: inputErr });
    if (!isValidE164(phone)) {
      return res.status(400).json({
        success: false,
        message: 'Enter the number in international format with country code (e.g. +91 98765 43210). WhatsApp cannot deliver to a number without one.',
      });
    }
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
    if (updates.phone !== undefined && !isValidE164(updates.phone)) {
      return res.status(400).json({
        success: false,
        message: 'Enter the number in international format with country code (e.g. +91 98765 43210).',
      });
    }
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
