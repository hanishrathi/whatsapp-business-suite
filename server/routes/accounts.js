const express = require('express');
const router = express.Router();
const WhatsAppAccount = require('../models/WhatsAppAccount');
const { protect, requireVerified } = require('../middleware/auth');
const { encrypt } = require('../utils/crypto');
const { logAction } = require('../utils/audit');

const MAX_ACCOUNTS = parseInt(process.env.MAX_WHATSAPP_ACCOUNTS || '25', 10);

// phoneNumberId from Meta is always numeric — reject anything else (prevents URL/path injection).
function isValidPhoneNumberId(v) {
  return v === undefined || v === '' || /^\d{1,32}$/.test(v);
}

// GET /api/accounts — list all accounts for current user
router.get('/', protect, async (req, res) => {
  try {
    const accounts = await WhatsAppAccount.find({
      userId: req.user._id,
      isActive: true,
    }).sort({ createdAt: -1 });

    const total = accounts.reduce(
      (acc, a) => ({
        messages: acc.messages + a.totalMessages,
        contacts: acc.contacts + a.totalContacts,
      }),
      { messages: 0, contacts: 0 }
    );

    res.json({
      success: true,
      accounts,
      total,
      count: accounts.length,
      maxAccounts: MAX_ACCOUNTS,
    });
  } catch (err) {
    console.error('List accounts error:', err);
    res.status(500).json({ success: false, message: 'Failed to load accounts.' });
  }
});

// GET /api/accounts/:id — get single account
router.get('/:id', protect, async (req, res) => {
  try {
    const account = await WhatsAppAccount.findOne({
      _id: req.params.id,
      userId: req.user._id,
      isActive: true,
    });

    if (!account) {
      return res.status(404).json({ success: false, message: 'Account not found.' });
    }

    res.json({ success: true, account });
  } catch (err) {
    console.error('Get account error:', err);
    res.status(500).json({ success: false, message: 'Failed to load account.' });
  }
});

// POST /api/accounts — create new WhatsApp account (requires verified email + phone)
router.post('/', protect, requireVerified, async (req, res) => {
  try {
    // Check limit
    const count = await WhatsAppAccount.countActiveForUser(req.user._id);
    if (count >= MAX_ACCOUNTS) {
      return res.status(400).json({
        success: false,
        message: `Maximum of ${MAX_ACCOUNTS} WhatsApp accounts allowed per user.`,
      });
    }

    const {
      name, phone, countryCode, category, categoryLabel,
      color, colorClass, wabaId, phoneNumberId, accessToken,
    } = req.body;

    // Validation
    if (!name || !phone) {
      return res.status(400).json({ success: false, message: 'Account name and phone number are required.' });
    }

    // Validate color hex
    if (color && !/^#([0-9A-Fa-f]{6})$/.test(color)) {
      return res.status(400).json({ success: false, message: 'Invalid color code. Use hex format like #25D366.' });
    }

    // Validate phoneNumberId format (numeric only) to prevent injection.
    if (!isValidPhoneNumberId(phoneNumberId)) {
      return res.status(400).json({ success: false, message: 'Invalid phone number ID.' });
    }

    // Check duplicate phone for this user
    const existing = await WhatsAppAccount.findOne({
      userId: req.user._id,
      phone,
      isActive: true,
    });

    if (existing) {
      return res.status(409).json({ success: false, message: 'This phone number is already connected.' });
    }

    const account = await WhatsAppAccount.create({
      userId: req.user._id,
      name: name.trim(),
      phone,
      countryCode: countryCode || '+91',
      category: category || 'general',
      categoryLabel: categoryLabel || 'General',
      color: color || '#25D366',
      colorClass: colorClass || 'green',
      wabaId: wabaId || '',
      phoneNumberId: phoneNumberId || '',
      // F1: encrypt the access token at rest (AES-256-GCM).
      accessToken: accessToken ? encrypt(accessToken) : '',
      // F9: do NOT fake-verify. Real verification happens only after a Meta API check.
      status: wabaId ? 'connecting' : 'offline',
      isVerified: false,
    });

    await logAction(req, 'whatsapp_account.create', {
      targetId: account._id,
      meta: { name: account.name, phone: account.phone },
    });

    // Never echo the access token back in the response.
    const safeAccount = account.toObject();
    delete safeAccount.accessToken;

    res.status(201).json({
      success: true,
      account: safeAccount,
      message: 'WhatsApp account added. It will show as connected once verified with Meta.',
      remainingSlots: MAX_ACCOUNTS - count - 1,
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: 'This phone number is already connected.' });
    }
    console.error('Create account error:', err);
    res.status(500).json({ success: false, message: 'Failed to add account.' });
  }
});

// PUT /api/accounts/:id — update account (requires verified email + phone)
router.put('/:id', protect, requireVerified, async (req, res) => {
  try {
    const allowed = [
      'name', 'category', 'categoryLabel', 'color', 'colorClass',
      'wabaId', 'phoneNumberId', 'accessToken',
    ];

    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates[key] = req.body[key];
      }
    }

    // Validate color hex if provided
    if (updates.color && !/^#([0-9A-Fa-f]{6})$/.test(updates.color)) {
      return res.status(400).json({ success: false, message: 'Invalid color code.' });
    }

    // Validate phoneNumberId if provided
    if (!isValidPhoneNumberId(updates.phoneNumberId)) {
      return res.status(400).json({ success: false, message: 'Invalid phone number ID.' });
    }

    // F1: encrypt access token at rest if it's being changed.
    if (updates.accessToken !== undefined) {
      updates.accessToken = updates.accessToken ? encrypt(updates.accessToken) : '';
    }

    const account = await WhatsAppAccount.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id, isActive: true },
      updates,
      { new: true, runValidators: true }
    );

    if (!account) {
      return res.status(404).json({ success: false, message: 'Account not found.' });
    }

    await logAction(req, 'whatsapp_account.update', { targetId: account._id });

    const safeAccount = account.toObject();
    delete safeAccount.accessToken;

    res.json({ success: true, account: safeAccount, message: 'Account updated.' });
  } catch (err) {
    console.error('Update account error:', err);
    res.status(500).json({ success: false, message: 'Failed to update account.' });
  }
});

// PUT /api/accounts/:id/color — update color only (quick action)
router.put('/:id/color', protect, requireVerified, async (req, res) => {
  try {
    const { color, colorClass } = req.body;

    if (!color || !/^#([0-9A-Fa-f]{6})$/.test(color)) {
      return res.status(400).json({ success: false, message: 'Invalid color code.' });
    }

    const account = await WhatsAppAccount.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id, isActive: true },
      { color, colorClass: colorClass || 'custom' },
      { new: true }
    );

    if (!account) {
      return res.status(404).json({ success: false, message: 'Account not found.' });
    }

    res.json({ success: true, account, message: 'Color updated.' });
  } catch (err) {
    console.error('Update color error:', err);
    res.status(500).json({ success: false, message: 'Failed to update color.' });
  }
});

// DELETE /api/accounts/:id — remove account (requires verified email + phone)
router.delete('/:id', protect, requireVerified, async (req, res) => {
  try {
    const account = await WhatsAppAccount.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id, isActive: true },
      { isActive: false, status: 'offline' },
      { new: true }
    );

    if (!account) {
      return res.status(404).json({ success: false, message: 'Account not found.' });
    }

    await logAction(req, 'whatsapp_account.delete', {
      targetId: account._id,
      meta: { name: account.name, phone: account.phone },
    });

    const remaining = await WhatsAppAccount.countActiveForUser(req.user._id);

    res.json({
      success: true,
      message: `"${account.name}" has been disconnected.`,
      remainingAccounts: remaining,
    });
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ success: false, message: 'Failed to remove account.' });
  }
});

module.exports = router;
