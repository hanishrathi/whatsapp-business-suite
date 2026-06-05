const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { protect, signToken } = require('../middleware/auth');
const { generateOTP, sendEmailOTP, sendWhatsAppOTP } = require('../utils/otp');

const OTP_EXPIRY = parseInt(process.env.OTP_EXPIRY_MINUTES || '10', 10) * 60 * 1000;

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { name, email, phone, password, company } = req.body;

    // Validation
    if (!name || !email || !phone || !password) {
      return res.status(400).json({ success: false, message: 'All fields are required.' });
    }

    if (password.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
    }

    // Check existing
    const existing = await User.findOne({ $or: [{ email }, { phone }] });
    if (existing) {
      const field = existing.email === email.toLowerCase() ? 'email' : 'phone';
      return res.status(409).json({ success: false, message: `An account with this ${field} already exists.` });
    }

    // Create user
    const user = await User.create({
      name,
      email,
      phone,
      password,
      company: company || '',
    });

    // Generate OTPs
    const emailOtp = generateOTP();
    const phoneOtp = generateOTP();

    user.emailOtp = emailOtp;
    user.emailOtpExpiry = new Date(Date.now() + OTP_EXPIRY);
    user.phoneOtp = phoneOtp;
    user.phoneOtpExpiry = new Date(Date.now() + OTP_EXPIRY);
    await user.save();

    // Send OTPs (non-blocking)
    sendEmailOTP(email, emailOtp, name).catch(err => console.error('Email OTP error:', err.message));
    sendWhatsAppOTP(phone, phoneOtp).catch(err => console.error('WhatsApp OTP error:', err.message));

    // Generate token
    const token = signToken(user._id);

    res.status(201).json({
      success: true,
      message: 'Account created. Please verify your email and phone.',
      token,
      user: user.toSafeJSON(),
      pendingVerification: { email: true, phone: true },
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: 'Account already exists.' });
    }
    console.error('Register error:', err);
    res.status(500).json({ success: false, message: 'Registration failed. Please try again.' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    const user = await User.findOne({ email }).select('+password');
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    if (!user.isActive) {
      return res.status(401).json({ success: false, message: 'This account has been deactivated.' });
    }

    if (user.isLocked()) {
      return res.status(423).json({ success: false, message: 'Account is temporarily locked. Try again in 15 minutes.' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      await user.incLoginAttempts();
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    // Reset attempts on success
    await user.resetLoginAttempts();
    user.lastLogin = new Date();
    await user.save();

    const token = signToken(user._id);

    res.json({
      success: true,
      token,
      user: user.toSafeJSON(),
      pendingVerification: {
        email: !user.isEmailVerified,
        phone: !user.isPhoneVerified,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Login failed.' });
  }
});

// POST /api/auth/verify-email
router.post('/verify-email', protect, async (req, res) => {
  try {
    const { otp } = req.body;
    const user = await User.findById(req.user._id).select('+emailOtp +emailOtpExpiry');

    if (user.isEmailVerified) {
      return res.json({ success: true, message: 'Email already verified.' });
    }

    if (!user.emailOtp || user.emailOtpExpiry < Date.now()) {
      return res.status(400).json({ success: false, message: 'OTP expired. Request a new one.' });
    }

    if (user.emailOtp !== otp) {
      return res.status(400).json({ success: false, message: 'Invalid OTP.' });
    }

    user.isEmailVerified = true;
    user.emailOtp = undefined;
    user.emailOtpExpiry = undefined;
    await user.save();

    res.json({ success: true, message: 'Email verified successfully.' });
  } catch (err) {
    console.error('Verify email error:', err);
    res.status(500).json({ success: false, message: 'Verification failed.' });
  }
});

// POST /api/auth/verify-phone
router.post('/verify-phone', protect, async (req, res) => {
  try {
    const { otp } = req.body;
    const user = await User.findById(req.user._id).select('+phoneOtp +phoneOtpExpiry');

    if (user.isPhoneVerified) {
      return res.json({ success: true, message: 'Phone already verified.' });
    }

    if (!user.phoneOtp || user.phoneOtpExpiry < Date.now()) {
      return res.status(400).json({ success: false, message: 'OTP expired. Request a new one.' });
    }

    if (user.phoneOtp !== otp) {
      return res.status(400).json({ success: false, message: 'Invalid OTP.' });
    }

    user.isPhoneVerified = true;
    user.phoneOtp = undefined;
    user.phoneOtpExpiry = undefined;
    await user.save();

    res.json({ success: true, message: 'Phone verified successfully.' });
  } catch (err) {
    console.error('Verify phone error:', err);
    res.status(500).json({ success: false, message: 'Verification failed.' });
  }
});

// POST /api/auth/resend-otp
router.post('/resend-otp', protect, async (req, res) => {
  try {
    const { type } = req.body; // 'email' or 'phone'
    const user = await User.findById(req.user._id).select('+emailOtp +emailOtpExpiry +phoneOtp +phoneOtpExpiry');

    const otp = generateOTP();
    const expiry = new Date(Date.now() + OTP_EXPIRY);

    if (type === 'email') {
      if (user.isEmailVerified) {
        return res.json({ success: true, message: 'Email already verified.' });
      }
      user.emailOtp = otp;
      user.emailOtpExpiry = expiry;
      await user.save();
      sendEmailOTP(user.email, otp, user.name).catch(err => console.error('Resend email OTP error:', err));
    } else if (type === 'phone') {
      if (user.isPhoneVerified) {
        return res.json({ success: true, message: 'Phone already verified.' });
      }
      user.phoneOtp = otp;
      user.phoneOtpExpiry = expiry;
      await user.save();
      sendWhatsAppOTP(user.phone, otp).catch(err => console.error('Resend phone OTP error:', err));
    } else {
      return res.status(400).json({ success: false, message: 'Type must be "email" or "phone".' });
    }

    res.json({ success: true, message: `OTP sent to your ${type}.` });
  } catch (err) {
    console.error('Resend OTP error:', err);
    res.status(500).json({ success: false, message: 'Failed to resend OTP.' });
  }
});

// GET /api/auth/me
router.get('/me', protect, async (req, res) => {
  const user = await User.findById(req.user._id);
  res.json({ success: true, user: user.toSafeJSON() });
});

module.exports = router;
