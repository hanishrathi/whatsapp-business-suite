const express = require('express');
const router = express.Router();
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const User = require('../models/User');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const { protect, signToken } = require('../middleware/auth');
const { encrypt, decrypt, hashToken } = require('../utils/crypto');
const totp = require('../utils/totp');
const { logAction } = require('../utils/audit');

// Multer config for avatar uploads
const upload = multer({
  limits: {
    fileSize: (parseInt(process.env.MAX_AVATAR_SIZE_MB || '5', 10)) * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, WebP, and GIF images are allowed.'));
    }
  },
  storage: multer.memoryStorage(),
});

// GET /api/users/profile
router.get('/profile', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const accountCount = await WhatsAppAccount.countActiveForUser(req.user._id);

    res.json({
      success: true,
      user: user.toSafeJSON(),
      accountCount,
      maxAccounts: parseInt(process.env.MAX_WHATSAPP_ACCOUNTS || '25', 10),
    });
  } catch (err) {
    console.error('Get profile error:', err);
    res.status(500).json({ success: false, message: 'Failed to load profile.' });
  }
});

// PUT /api/users/profile
router.put('/profile', protect, async (req, res) => {
  try {
    const { name, company, timezone } = req.body;
    const updates = {};

    if (name !== undefined) {
      if (name.length < 2 || name.length > 60) {
        return res.status(400).json({ success: false, message: 'Name must be 2-60 characters.' });
      }
      updates.name = name.trim();
    }
    if (company !== undefined) updates.company = company.trim();
    if (timezone !== undefined) updates.timezone = timezone;

    const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true, runValidators: true });

    res.json({ success: true, user: user.toSafeJSON(), message: 'Profile updated.' });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ success: false, message: 'Failed to update profile.' });
  }
});

// POST /api/users/avatar
router.post('/avatar', protect, upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image file provided.' });
    }

    const filename = `${req.user._id}-${uuidv4()}.webp`;
    const uploadDir = path.join(__dirname, '..', 'uploads', 'avatars');

    // Ensure upload directory exists
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const filePath = path.join(uploadDir, filename);

    // Process image: resize, convert to webp
    await sharp(req.file.buffer)
      .resize(256, 256, { fit: 'cover', position: 'centre' })
      .webp({ quality: 85 })
      .toFile(filePath);

    // Delete old avatar if exists
    if (req.user.avatar) {
      const oldPath = path.join(uploadDir, path.basename(req.user.avatar));
      if (fs.existsSync(oldPath)) {
        fs.unlinkSync(oldPath);
      }
    }

    const avatarUrl = `/uploads/avatars/${filename}`;
    await User.findByIdAndUpdate(req.user._id, { avatar: avatarUrl });

    res.json({ success: true, avatar: avatarUrl, message: 'Avatar updated.' });
  } catch (err) {
    console.error('Avatar upload error:', err);
    res.status(500).json({ success: false, message: 'Failed to upload avatar.' });
  }
});

// DELETE /api/users/avatar
router.delete('/avatar', protect, async (req, res) => {
  try {
    if (req.user.avatar) {
      const filePath = path.join(__dirname, '..', 'uploads', 'avatars', path.basename(req.user.avatar));
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    await User.findByIdAndUpdate(req.user._id, { avatar: null });
    res.json({ success: true, message: 'Avatar removed.' });
  } catch (err) {
    console.error('Delete avatar error:', err);
    res.status(500).json({ success: false, message: 'Failed to remove avatar.' });
  }
});

// PUT /api/users/password
router.put('/password', protect, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Both current and new passwords are required.' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, message: 'New password must be at least 8 characters.' });
    }

    const user = await User.findById(req.user._id).select('+password');
    const isMatch = await user.comparePassword(currentPassword);

    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
    }

    user.password = newPassword;
    // F5: invalidate all existing sessions/tokens issued before this change.
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    await logAction(req, 'user.password_change', { targetId: user._id });

    // Re-issue a fresh token so the current session stays logged in.
    const token = signToken(user);
    res.json({ success: true, message: 'Password updated successfully.', token });
  } catch (err) {
    console.error('Change password error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to change password.' });
  }
});

// POST /api/users/logout-all — invalidate every active session for this user.
router.post('/logout-all', protect, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user._id, { $inc: { tokenVersion: 1 } });
    await logAction(req, 'user.logout_all', { targetId: req.user._id });
    res.json({ success: true, message: 'Signed out of all devices. Please log in again.' });
  } catch (err) {
    console.error('Logout-all error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to sign out everywhere.' });
  }
});

// DELETE /api/users/account
router.delete('/account', protect, async (req, res) => {
  try {
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ success: false, message: 'Password required to delete account.' });
    }

    const user = await User.findById(req.user._id).select('+password');
    const isMatch = await user.comparePassword(password);

    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Incorrect password.' });
    }

    // F7: real erasure — anonymize PII and FREE the email/phone so the person
    // can sign up again later. The row is kept only as a tombstone for audit.
    const tombstone = String(user._id);
    await User.findByIdAndUpdate(req.user._id, {
      isActive: false,
      deleteRequestedAt: new Date(),
      name: 'Deleted user',
      email: `deleted+${tombstone}@deleted.invalid`,
      phone: `deleted-${tombstone}`,
      company: '',
      avatar: null,
      mfaEnabled: false,
      mfaSecret: undefined,
      mfaBackupCodes: [],
      emailOtp: undefined,
      phoneOtp: undefined,
      // Invalidate any tokens that were issued for this account.
      $inc: { tokenVersion: 1 },
    });

    // Hard-delete the user's WhatsApp accounts (incl. encrypted tokens).
    await WhatsAppAccount.deleteMany({ userId: req.user._id });

    // Delete avatar file
    if (user.avatar) {
      const filePath = path.join(__dirname, '..', 'uploads', 'avatars', path.basename(user.avatar));
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    await logAction(req, 'user.account_delete', { targetId: user._id });
    res.json({ success: true, message: 'Account deleted. Your personal data has been removed.' });
  } catch (err) {
    console.error('Delete account error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete account.' });
  }
});

/* ===================== F4: TOTP Multi-Factor Auth ===================== */

// POST /api/users/mfa/setup — begin enrollment: returns a QR code + secret.
router.post('/mfa/setup', protect, async (req, res) => {
  try {
    if (req.user.mfaEnabled) {
      return res.status(400).json({ success: false, message: 'Two-factor auth is already enabled.' });
    }
    const secret = totp.generateSecret();
    const enrollment = await totp.buildEnrollment(secret, req.user.email);

    // Store the secret ENCRYPTED but mark MFA not-yet-enabled until confirmed.
    await User.findByIdAndUpdate(req.user._id, { mfaSecret: encrypt(secret), mfaEnabled: false });

    res.json({
      success: true,
      qr: enrollment.qrDataUrl,      // <img src="...">
      secret,                         // for manual entry
      message: 'Scan the QR in Google Authenticator, then confirm with a code.',
    });
  } catch (err) {
    console.error('MFA setup error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to start 2FA setup.' });
  }
});

// POST /api/users/mfa/enable — confirm a code, turn MFA on, return backup codes once.
router.post('/mfa/enable', protect, async (req, res) => {
  try {
    const { code } = req.body;
    const user = await User.findById(req.user._id).select('+mfaSecret +mfaBackupCodes');
    if (!user.mfaSecret) {
      return res.status(400).json({ success: false, message: 'Start 2FA setup first.' });
    }
    const secret = decrypt(user.mfaSecret);
    if (!totp.verifyToken(code, secret)) {
      return res.status(400).json({ success: false, message: 'Incorrect code. Try again.' });
    }

    const backup = totp.generateBackupCodes(8);
    user.mfaEnabled = true;
    user.mfaBackupCodes = backup.hashed;       // store hashes only
    user.tokenVersion = (user.tokenVersion || 0) + 1; // force re-login elsewhere
    await user.save();

    await logAction(req, 'user.mfa_enabled', { targetId: user._id });
    res.json({
      success: true,
      message: 'Two-factor authentication enabled.',
      backupCodes: backup.plain,   // shown ONCE — user must save these
      token: signToken(user),
    });
  } catch (err) {
    console.error('MFA enable error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to enable 2FA.' });
  }
});

// POST /api/users/mfa/disable — require password to turn MFA off.
router.post('/mfa/disable', protect, async (req, res) => {
  try {
    const { password } = req.body;
    const user = await User.findById(req.user._id).select('+password');
    if (!password || !(await user.comparePassword(password))) {
      return res.status(401).json({ success: false, message: 'Password is incorrect.' });
    }
    user.mfaEnabled = false;
    user.mfaSecret = undefined;
    user.mfaBackupCodes = [];
    await user.save();
    await logAction(req, 'user.mfa_disabled', { targetId: user._id });
    res.json({ success: true, message: 'Two-factor authentication disabled.' });
  } catch (err) {
    console.error('MFA disable error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to disable 2FA.' });
  }
});

module.exports = router;
