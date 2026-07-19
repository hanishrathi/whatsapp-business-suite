const express = require('express');
const router = express.Router();
const waAccounts = require('../data/whatsappAccounts');
const { protect, requireVerified } = require('../middleware/auth');
const { encrypt } = require('../utils/crypto');
const wa = require('../utils/whatsapp');
const { logAction } = require('../utils/audit');

const MAX_ACCOUNTS = parseInt(process.env.MAX_WHATSAPP_ACCOUNTS || '25', 10);

function isValidPhoneNumberId(v) {
  return v === undefined || v === '' || /^\d{1,32}$/.test(v);
}

// GET /api/accounts — list all accounts for current user
router.get('/', protect, (req, res) => {
  try {
    const accounts = waAccounts.listForUser(req.user._id);
    const total = accounts.reduce((acc, a) => ({
      messages: acc.messages + a.totalMessages,
      contacts: acc.contacts + a.totalContacts,
    }), { messages: 0, contacts: 0 });
    res.json({ success: true, accounts, total, count: accounts.length, maxAccounts: MAX_ACCOUNTS });
  } catch (err) {
    console.error('List accounts error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load accounts.' });
  }
});

// GET /api/accounts/:id
router.get('/:id', protect, (req, res) => {
  try {
    const account = waAccounts.findForUser(req.params.id, req.user._id);
    if (!account) return res.status(404).json({ success: false, message: 'Account not found.' });
    res.json({ success: true, account });
  } catch (err) {
    console.error('Get account error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load account.' });
  }
});

// POST /api/accounts
router.post('/', protect, requireVerified, (req, res) => {
  try {
    if (waAccounts.countActiveForUser(req.user._id) >= MAX_ACCOUNTS) {
      return res.status(400).json({ success: false, message: `Maximum of ${MAX_ACCOUNTS} WhatsApp accounts allowed per user.` });
    }
    const { name, phone, countryCode, category, categoryLabel, color, colorClass, wabaId, phoneNumberId, accessToken } = req.body;
    if (!name || !phone) return res.status(400).json({ success: false, message: 'Account name and phone number are required.' });
    if (color && !/^#([0-9A-Fa-f]{6})$/.test(color)) return res.status(400).json({ success: false, message: 'Invalid color code. Use hex format like #25D366.' });
    if (!isValidPhoneNumberId(phoneNumberId)) return res.status(400).json({ success: false, message: 'Invalid phone number ID.' });

    if (waAccounts.findActiveByPhone(req.user._id, phone)) {
      return res.status(409).json({ success: false, message: 'This phone number is already connected.' });
    }

    let account;
    try {
      account = waAccounts.create({
        userId: req.user._id, name: name.trim(), phone,
        countryCode: countryCode || '+91', category: category || 'general', categoryLabel: categoryLabel || 'General',
        color: color || '#25D366', colorClass: colorClass || 'green',
        wabaId: wabaId || '', phoneNumberId: phoneNumberId || '',
        accessToken: accessToken ? encrypt(accessToken) : '',   // F1: encrypt at rest
        status: wabaId ? 'connecting' : 'offline', isVerified: false, // F9: no fake verify
      });
    } catch (err) {
      if (err.code === 11000 || /UNIQUE/i.test(err.message)) return res.status(409).json({ success: false, message: 'This phone number is already connected.' });
      throw err;
    }

    logAction(req, 'whatsapp_account.create', { targetId: account._id, meta: { name: account.name, phone: account.phone } });
    delete account.accessToken; // never echo the token
    res.status(201).json({
      success: true, account,
      message: 'WhatsApp account added. It will show as connected once verified with Meta.',
      remainingSlots: MAX_ACCOUNTS - waAccounts.countActiveForUser(req.user._id),
    });
  } catch (err) {
    console.error('Create account error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to add account.' });
  }
});

// PUT /api/accounts/:id
router.put('/:id', protect, requireVerified, (req, res) => {
  try {
    const allowed = ['name', 'category', 'categoryLabel', 'color', 'colorClass', 'wabaId', 'phoneNumberId', 'accessToken'];
    const updates = {};
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
    if (updates.color && !/^#([0-9A-Fa-f]{6})$/.test(updates.color)) return res.status(400).json({ success: false, message: 'Invalid color code.' });
    if (!isValidPhoneNumberId(updates.phoneNumberId)) return res.status(400).json({ success: false, message: 'Invalid phone number ID.' });
    if (updates.accessToken !== undefined) updates.accessToken = updates.accessToken ? encrypt(updates.accessToken) : '';

    const account = waAccounts.update(req.params.id, req.user._id, updates);
    if (!account) return res.status(404).json({ success: false, message: 'Account not found.' });
    logAction(req, 'whatsapp_account.update', { targetId: account._id });
    res.json({ success: true, account, message: 'Account updated.' });
  } catch (err) {
    console.error('Update account error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update account.' });
  }
});

// PUT /api/accounts/:id/color
router.put('/:id/color', protect, requireVerified, (req, res) => {
  try {
    const { color, colorClass } = req.body;
    if (!color || !/^#([0-9A-Fa-f]{6})$/.test(color)) return res.status(400).json({ success: false, message: 'Invalid color code.' });
    const account = waAccounts.update(req.params.id, req.user._id, { color, colorClass: colorClass || 'custom' });
    if (!account) return res.status(404).json({ success: false, message: 'Account not found.' });
    res.json({ success: true, account, message: 'Color updated.' });
  } catch (err) {
    console.error('Update color error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update color.' });
  }
});

// POST /api/accounts/:id/test — live credential check against Meta
router.post('/:id/test', protect, requireVerified, async (req, res) => {
  try {
    const account = waAccounts.findForUserWithToken(req.params.id, req.user._id);
    if (!account) return res.status(404).json({ success: false, message: 'Account not found.' });

    const r = await wa.testConnection(account);
    const qualityMap = { green: 'high', yellow: 'medium', red: 'low' };
    waAccounts.update(req.params.id, req.user._id, {
      status: r.ok ? 'connected' : 'error',
      isVerified: r.ok,
      verifiedAt: r.ok ? new Date() : null,
      ...(r.ok && r.qualityRating ? {
        quality: qualityMap[r.qualityRating] || 'high',
        qualityLabel: (qualityMap[r.qualityRating] || 'high').replace(/^./, c => c.toUpperCase()),
      } : {}),
    });
    logAction(req, 'whatsapp_account.test', { targetId: req.params.id, meta: { ok: r.ok } });

    if (!r.ok) return res.status(400).json({ success: false, message: `Connection failed: ${r.error}` });
    res.json({
      success: true,
      message: `Connected! Verified as "${r.verifiedName || account.name}" (${r.displayPhoneNumber || account.phone}).`,
      verifiedName: r.verifiedName, displayPhoneNumber: r.displayPhoneNumber, qualityRating: r.qualityRating,
    });
  } catch (err) {
    console.error('Test account error:', err.message);
    res.status(500).json({ success: false, message: 'Connection test failed.' });
  }
});

// DELETE /api/accounts/:id
router.delete('/:id', protect, requireVerified, (req, res) => {
  try {
    const account = waAccounts.softDelete(req.params.id, req.user._id);
    if (!account) return res.status(404).json({ success: false, message: 'Account not found.' });
    logAction(req, 'whatsapp_account.delete', { targetId: account._id, meta: { name: account.name, phone: account.phone } });
    res.json({ success: true, message: `"${account.name}" has been disconnected.`, remainingAccounts: waAccounts.countActiveForUser(req.user._id) });
  } catch (err) {
    console.error('Delete account error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to remove account.' });
  }
});

module.exports = router;
