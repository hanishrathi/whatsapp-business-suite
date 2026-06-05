const express = require('express');
const router = express.Router();
const WhatsAppAccount = require('../models/WhatsAppAccount');
const { protect, requireVerified } = require('../middleware/auth');

const MAX_ACCOUNTS = parseInt(process.env.MAX_WHATSAPP_ACCOUNTS || '25', 10);

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

// POST /api/accounts — create new WhatsApp account
router.post('/', protect, async (req, res) => {
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
      accessToken: accessToken || '',
      status: wabaId ? 'connecting' : 'offline',
    });

    // Simulate connection after a delay (in production this would be real API verification)
    if (wabaId) {
      setTimeout(async () => {
        try {
          await WhatsAppAccount.findByIdAndUpdate(account._id, {
            status: 'online',
            isVerified: true,
            verifiedAt: new Date(),
          });
        } catch (e) {
          console.error('Auto-verify error:', e);
        }
      }, 3000);
    }

    res.status(201).json({
      success: true,
      account,
      message: 'WhatsApp account added successfully.',
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

// PUT /api/accounts/:id — update account
router.put('/:id', protect, async (req, res) => {
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

    const account = await WhatsAppAccount.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id, isActive: true },
      updates,
      { new: true, runValidators: true }
    );

    if (!account) {
      return res.status(404).json({ success: false, message: 'Account not found.' });
    }

    res.json({ success: true, account, message: 'Account updated.' });
  } catch (err) {
    console.error('Update account error:', err);
    res.status(500).json({ success: false, message: 'Failed to update account.' });
  }
});

// PUT /api/accounts/:id/color — update color only (quick action)
router.put('/:id/color', protect, async (req, res) => {
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

// DELETE /api/accounts/:id — remove account (soft delete)
router.delete('/:id', protect, async (req, res) => {
  try {
    const account = await WhatsAppAccount.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id, isActive: true },
      { isActive: false, status: 'offline' },
      { new: true }
    );

    if (!account) {
      return res.status(404).json({ success: false, message: 'Account not found.' });
    }

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
