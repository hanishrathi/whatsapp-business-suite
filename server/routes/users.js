const express = require('express');
const router = express.Router();
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const User = require('../models/User');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const { protect } = require('../middleware/auth');

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
    await user.save();

    res.json({ success: true, message: 'Password updated successfully.' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ success: false, message: 'Failed to change password.' });
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

    // Soft-delete: deactivate user and all accounts
    await User.findByIdAndUpdate(req.user._id, {
      isActive: false,
      deleteRequestedAt: new Date(),
    });

    await WhatsAppAccount.updateMany(
      { userId: req.user._id },
      { isActive: false }
    );

    // Delete avatar file
    if (user.avatar) {
      const filePath = path.join(__dirname, '..', 'uploads', 'avatars', path.basename(user.avatar));
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    res.json({ success: true, message: 'Account deleted successfully.' });
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete account.' });
  }
});

module.exports = router;
