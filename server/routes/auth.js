const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { protect, signToken } = require('../middleware/auth');
const { generateOTP, sendEmailOTP, sendWhatsAppOTP } = require('../utils/otp');
const { hashToken, safeEqual, decrypt } = require('../utils/crypto');
const { verifyToken: verifyTotp, matchBackupCode } = require('../utils/totp');
const { logAction } = require('../utils/audit');

const OTP_EXPIRY = parseInt(process.env.OTP_EXPIRY_MINUTES || '10', 10) * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { name, email, phone, password, company } = req.body;

    if (!name || !email || !phone || !password) {
      return res.status(400).json({ success: false, message: 'All fields are required.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
    }

    // F11: do not reveal which accounts already exist. If a duplicate is found,
    // return the SAME generic success-shaped guidance instead of confirming the field.
    const existing = await User.findOne({ $or: [{ email: email.toLowerCase() }, { phone }] });
    if (existing) {
      return res.status(202).json({
        success: true,
        message: 'If this email and phone are available, your account has been created. Please check for your verification code, or try logging in.',
        duplicate: true,
      });
    }

    const user = await User.create({ name, email, phone, password, company: company || '' });

    // F10: generate OTPs, store only their HASHES.
    const emailOtp = generateOTP();
    const phoneOtp = generateOTP();
    user.emailOtp = hashToken(emailOtp);
    user.emailOtpExpiry = new Date(Date.now() + OTP_EXPIRY);
    user.emailOtpAttempts = 0;
    user.phoneOtp = hashToken(phoneOtp);
    user.phoneOtpExpiry = new Date(Date.now() + OTP_EXPIRY);
    user.phoneOtpAttempts = 0;
    await user.save();

    // Send the plaintext codes (never stored). Failures don't block registration.
    sendEmailOTP(email, emailOtp, name).catch(err => console.error('Email OTP send failed:', err.message));
    sendWhatsAppOTP(phone, phoneOtp).catch(err => console.error('WhatsApp OTP send failed:', err.message));

    await logAction(req, 'auth.register', { targetId: user._id });

    const token = signToken(user);
    res.status(201).json({
      success: true,
      message: 'Account created. Please verify your email and phone.',
      token,
      user: user.toSafeJSON(),
      pendingVerification: { email: true, phone: true },
    });
  } catch (err) {
    if (err.code === 11000) {
      // Duplicate key race — keep the same generic response.
      return res.status(202).json({
        success: true,
        message: 'If this email and phone are available, your account has been created. Please check for your verification code, or try logging in.',
        duplicate: true,
      });
    }
    console.error('Register error:', err.message);
    res.status(500).json({ success: false, message: 'Registration failed. Please try again.' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password, mfaCode } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    const user = await User.findOne({ email: email.toLowerCase() })
      .select('+password +mfaSecret +mfaBackupCodes');
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
      await logAction(req, 'auth.login_failed', { targetId: user._id });
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    // F4: second factor, if enabled.
    if (user.mfaEnabled) {
      if (!mfaCode) {
        return res.status(206).json({
          success: false,
          mfaRequired: true,
          message: 'Enter the 6-digit code from your authenticator app.',
        });
      }
      // mfaSecret is stored encrypted — decrypt before verifying.
      let mfaOk = verifyTotp(mfaCode, decrypt(user.mfaSecret));
      if (!mfaOk) {
        // Allow a one-time backup code.
        const idx = matchBackupCode(mfaCode, user.mfaBackupCodes || []);
        if (idx >= 0) {
          user.mfaBackupCodes.splice(idx, 1); // consume it
          mfaOk = true;
        }
      }
      if (!mfaOk) {
        await user.incLoginAttempts();
        await logAction(req, 'auth.mfa_failed', { targetId: user._id });
        return res.status(401).json({ success: false, mfaRequired: true, message: 'Invalid authenticator code.' });
      }
    }

    await user.resetLoginAttempts();
    user.lastLogin = new Date();
    await user.save();

    await logAction(req, 'auth.login', { targetId: user._id });

    const token = signToken(user);
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
    console.error('Login error:', err.message);
    res.status(500).json({ success: false, message: 'Login failed.' });
  }
});

// Shared OTP verification logic (F10: hashed compare, attempt cap, single-use).
async function verifyOtpFlow(req, res, kind) {
  const isEmail = kind === 'email';
  const otpField = isEmail ? 'emailOtp' : 'phoneOtp';
  const expiryField = isEmail ? 'emailOtpExpiry' : 'phoneOtpExpiry';
  const attemptsField = isEmail ? 'emailOtpAttempts' : 'phoneOtpAttempts';
  const verifiedField = isEmail ? 'isEmailVerified' : 'isPhoneVerified';

  const { otp } = req.body;
  const user = await User.findById(req.user._id)
    .select(`+${otpField} +${expiryField} +${attemptsField}`);

  if (user[verifiedField]) {
    return res.json({ success: true, message: `${isEmail ? 'Email' : 'Phone'} already verified.` });
  }
  if (!user[otpField] || user[expiryField] < Date.now()) {
    return res.status(400).json({ success: false, message: 'Code expired. Request a new one.' });
  }
  if (user[attemptsField] >= MAX_OTP_ATTEMPTS) {
    // Lock this OTP — force a resend.
    user[otpField] = undefined;
    user[expiryField] = undefined;
    await user.save();
    return res.status(429).json({ success: false, message: 'Too many incorrect attempts. Request a new code.' });
  }

  const submittedHash = hashToken(String(otp || '').trim());
  if (!safeEqual(submittedHash, user[otpField])) {
    user[attemptsField] = (user[attemptsField] || 0) + 1;
    await user.save();
    return res.status(400).json({ success: false, message: 'Invalid code.' });
  }

  // Success — single use: clear it.
  user[verifiedField] = true;
  user[otpField] = undefined;
  user[expiryField] = undefined;
  user[attemptsField] = 0;
  await user.save();

  await logAction(req, isEmail ? 'auth.verify_email' : 'auth.verify_phone', { targetId: user._id });
  res.json({ success: true, message: `${isEmail ? 'Email' : 'Phone'} verified successfully.` });
}

// POST /api/auth/verify-email
router.post('/verify-email', protect, async (req, res) => {
  try {
    await verifyOtpFlow(req, res, 'email');
  } catch (err) {
    console.error('Verify email error:', err.message);
    res.status(500).json({ success: false, message: 'Verification failed.' });
  }
});

// POST /api/auth/verify-phone
router.post('/verify-phone', protect, async (req, res) => {
  try {
    await verifyOtpFlow(req, res, 'phone');
  } catch (err) {
    console.error('Verify phone error:', err.message);
    res.status(500).json({ success: false, message: 'Verification failed.' });
  }
});

// POST /api/auth/resend-otp
router.post('/resend-otp', protect, async (req, res) => {
  try {
    const { type } = req.body; // 'email' or 'phone'
    const user = await User.findById(req.user._id)
      .select('+emailOtp +emailOtpExpiry +emailOtpAttempts +phoneOtp +phoneOtpExpiry +phoneOtpAttempts');

    const otp = generateOTP();
    const expiry = new Date(Date.now() + OTP_EXPIRY);

    if (type === 'email') {
      if (user.isEmailVerified) return res.json({ success: true, message: 'Email already verified.' });
      user.emailOtp = hashToken(otp);
      user.emailOtpExpiry = expiry;
      user.emailOtpAttempts = 0;
      await user.save();
      sendEmailOTP(user.email, otp, user.name).catch(err => console.error('Resend email OTP failed:', err.message));
    } else if (type === 'phone') {
      if (user.isPhoneVerified) return res.json({ success: true, message: 'Phone already verified.' });
      user.phoneOtp = hashToken(otp);
      user.phoneOtpExpiry = expiry;
      user.phoneOtpAttempts = 0;
      await user.save();
      sendWhatsAppOTP(user.phone, otp).catch(err => console.error('Resend phone OTP failed:', err.message));
    } else {
      return res.status(400).json({ success: false, message: 'Type must be "email" or "phone".' });
    }

    res.json({ success: true, message: `Verification code sent to your ${type}.` });
  } catch (err) {
    console.error('Resend OTP error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to resend code.' });
  }
});

// GET /api/auth/me
router.get('/me', protect, async (req, res) => {
  const user = await User.findById(req.user._id);
  res.json({ success: true, user: user.toSafeJSON() });
});

module.exports = router;
