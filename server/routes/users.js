const express = require('express');
const router = express.Router();
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const users = require('../data/users');
const waAccounts = require('../data/whatsappAccounts');
const { protect, signToken } = require('../middleware/auth');
const { encrypt, decrypt } = require('../utils/crypto');
const totp = require('../utils/totp');
const { logAction } = require('../utils/audit');

// Multer config for avatar uploads
const upload = multer({
  limits: { fileSize: (parseInt(process.env.MAX_AVATAR_SIZE_MB || '5', 10)) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPEG, PNG, WebP, and GIF images are allowed.'));
  },
  storage: multer.memoryStorage(),
});

// GET /api/users/profile
router.get('/profile', protect, (req, res) => {
  try {
    const user = users.findById(req.user._id);
    const accountCount = waAccounts.countActiveForUser(req.user._id);
    res.json({
      success: true,
      user: users.toSafeJSON(user),
      accountCount,
      maxAccounts: parseInt(process.env.MAX_WHATSAPP_ACCOUNTS || '25', 10),
    });
  } catch (err) {
    console.error('Get profile error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load profile.' });
  }
});

// PUT /api/users/profile
router.put('/profile', protect, (req, res) => {
  try {
    const { name, company, timezone } = req.body;
    const updates = {};
    if (name !== undefined) {
      if (name.length < 2 || name.length > 60) return res.status(400).json({ success: false, message: 'Name must be 2-60 characters.' });
      updates.name = name.trim();
    }
    if (company !== undefined) updates.company = company.trim();
    if (timezone !== undefined) updates.timezone = timezone;
    const user = users.update(req.user._id, updates);
    res.json({ success: true, user: users.toSafeJSON(user), message: 'Profile updated.' });
  } catch (err) {
    console.error('Update profile error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update profile.' });
  }
});

// POST /api/users/avatar
router.post('/avatar', protect, upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No image file provided.' });
    const filename = `${req.user._id}-${uuidv4()}.webp`;
    const uploadDir = path.join(__dirname, '..', 'uploads', 'avatars');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    const filePath = path.join(uploadDir, filename);

    await sharp(req.file.buffer).resize(256, 256, { fit: 'cover', position: 'centre' }).webp({ quality: 85 }).toFile(filePath);

    if (req.user.avatar) {
      const oldPath = path.join(uploadDir, path.basename(req.user.avatar));
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    const avatarUrl = `/uploads/avatars/${filename}`;
    users.update(req.user._id, { avatar: avatarUrl });
    res.json({ success: true, avatar: avatarUrl, message: 'Avatar updated.' });
  } catch (err) {
    console.error('Avatar upload error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to upload avatar.' });
  }
});

// DELETE /api/users/avatar
router.delete('/avatar', protect, (req, res) => {
  try {
    if (req.user.avatar) {
      const filePath = path.join(__dirname, '..', 'uploads', 'avatars', path.basename(req.user.avatar));
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    users.update(req.user._id, { avatar: null });
    res.json({ success: true, message: 'Avatar removed.' });
  } catch (err) {
    console.error('Delete avatar error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to remove avatar.' });
  }
});

// PUT /api/users/password
router.put('/password', protect, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ success: false, message: 'Both current and new passwords are required.' });
    if (newPassword.length < 8) return res.status(400).json({ success: false, message: 'New password must be at least 8 characters.' });

    const user = users.findById(req.user._id);
    if (!(await users.comparePassword(currentPassword, user.password))) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
    }
    const fresh = await users.setPassword(user._id, newPassword); // hashes + bumps tokenVersion
    logAction(req, 'user.password_change', { targetId: user._id });
    res.json({ success: true, message: 'Password updated successfully.', token: signToken(fresh) });
  } catch (err) {
    console.error('Change password error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to change password.' });
  }
});

// POST /api/users/logout-all
router.post('/logout-all', protect, (req, res) => {
  try {
    const user = users.findById(req.user._id);
    users.update(user._id, { tokenVersion: (user.tokenVersion || 0) + 1 });
    logAction(req, 'user.logout_all', { targetId: user._id });
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
    if (!password) return res.status(400).json({ success: false, message: 'Password required to delete account.' });

    const user = users.findById(req.user._id);
    if (!(await users.comparePassword(password, user.password))) {
      return res.status(401).json({ success: false, message: 'Incorrect password.' });
    }

    // F7: anonymize PII and free the email/phone for reuse.
    const tombstone = String(user._id);
    users.update(user._id, {
      isActive: false, deleteRequestedAt: new Date(),
      name: 'Deleted user', email: `deleted+${tombstone}@deleted.invalid`, phone: `deleted-${tombstone}`,
      company: '', avatar: null, mfaEnabled: false, mfaSecret: undefined, mfaBackupCodes: [],
      emailOtp: undefined, phoneOtp: undefined, tokenVersion: (user.tokenVersion || 0) + 1,
    });
    waAccounts.deleteAllForUser(user._id);

    if (user.avatar) {
      const filePath = path.join(__dirname, '..', 'uploads', 'avatars', path.basename(user.avatar));
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    logAction(req, 'user.account_delete', { targetId: user._id });
    res.json({ success: true, message: 'Account deleted. Your personal data has been removed.' });
  } catch (err) {
    console.error('Delete account error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete account.' });
  }
});

/* ===================== F4: TOTP Multi-Factor Auth ===================== */

router.post('/mfa/setup', protect, async (req, res) => {
  try {
    if (req.user.mfaEnabled) return res.status(400).json({ success: false, message: 'Two-factor auth is already enabled.' });
    const secret = totp.generateSecret();
    const enrollment = await totp.buildEnrollment(secret, req.user.email);
    users.update(req.user._id, { mfaSecret: encrypt(secret), mfaEnabled: false });
    res.json({ success: true, qr: enrollment.qrDataUrl, secret, message: 'Scan the QR in Google Authenticator, then confirm with a code.' });
  } catch (err) {
    console.error('MFA setup error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to start 2FA setup.' });
  }
});

router.post('/mfa/enable', protect, (req, res) => {
  try {
    const { code } = req.body;
    const user = users.findById(req.user._id);
    if (!user.mfaSecret) return res.status(400).json({ success: false, message: 'Start 2FA setup first.' });
    if (!totp.verifyToken(code, decrypt(user.mfaSecret))) {
      return res.status(400).json({ success: false, message: 'Incorrect code. Try again.' });
    }
    const backup = totp.generateBackupCodes(8);
    const fresh = users.update(user._id, {
      mfaEnabled: true, mfaBackupCodes: backup.hashed, tokenVersion: (user.tokenVersion || 0) + 1,
    });
    logAction(req, 'user.mfa_enabled', { targetId: user._id });
    res.json({ success: true, message: 'Two-factor authentication enabled.', backupCodes: backup.plain, token: signToken(fresh) });
  } catch (err) {
    console.error('MFA enable error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to enable 2FA.' });
  }
});

router.post('/mfa/disable', protect, async (req, res) => {
  try {
    const { password } = req.body;
    const user = users.findById(req.user._id);
    if (!password || !(await users.comparePassword(password, user.password))) {
      return res.status(401).json({ success: false, message: 'Password is incorrect.' });
    }
    users.update(user._id, { mfaEnabled: false, mfaSecret: undefined, mfaBackupCodes: [] });
    logAction(req, 'user.mfa_disabled', { targetId: user._id });
    res.json({ success: true, message: 'Two-factor authentication disabled.' });
  } catch (err) {
    console.error('MFA disable error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to disable 2FA.' });
  }
});

module.exports = router;
