const express = require('express');
const router = express.Router();
const users = require('../data/users');
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

    // F11: never reveal which field already exists.
    const existing = users.findByEmailOrPhone(email, phone);
    if (existing) {
      return res.status(202).json({
        success: true,
        message: 'If this email and phone are available, your account has been created. Please check for your verification code, or try logging in.',
        duplicate: true,
      });
    }

    let user;
    try {
      user = await users.create({ name, email, phone, password, company });
    } catch (err) {
      if (err.code === 11000) {
        return res.status(202).json({ success: true, duplicate: true,
          message: 'If this email and phone are available, your account has been created. Please check for your verification code, or try logging in.' });
      }
      if (/must be|Invalid|required/i.test(err.message)) {
        return res.status(400).json({ success: false, message: err.message });
      }
      throw err;
    }

    // F10: store only OTP hashes.
    const emailOtp = generateOTP();
    const phoneOtp = generateOTP();
    users.update(user._id, {
      emailOtp: hashToken(emailOtp), emailOtpExpiry: new Date(Date.now() + OTP_EXPIRY), emailOtpAttempts: 0,
      phoneOtp: hashToken(phoneOtp), phoneOtpExpiry: new Date(Date.now() + OTP_EXPIRY), phoneOtpAttempts: 0,
    });

    sendEmailOTP(email, emailOtp, name).catch(e => console.error('Email OTP send failed:', e.message));
    sendWhatsAppOTP(phone, phoneOtp).catch(e => console.error('WhatsApp OTP send failed:', e.message));

    logAction(req, 'auth.register', { targetId: user._id });

    const token = signToken(user);
    res.status(201).json({
      success: true,
      message: 'Account created. Please verify your email and phone.',
      token,
      user: users.toSafeJSON(user),
      pendingVerification: { email: true, phone: true },
    });
  } catch (err) {
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

    const user = users.findByEmail(email);
    if (!user) return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    if (!user.isActive) return res.status(401).json({ success: false, message: 'This account has been deactivated.' });
    if (users.isLocked(user)) return res.status(423).json({ success: false, message: 'Account is temporarily locked. Try again in 15 minutes.' });

    const isMatch = await users.comparePassword(password, user.password);
    if (!isMatch) {
      users.incLoginAttempts(user);
      logAction(req, 'auth.login_failed', { targetId: user._id });
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    // F4: second factor if enabled.
    if (user.mfaEnabled) {
      if (!mfaCode) return res.status(206).json({ success: false, mfaRequired: true, message: 'Enter the 6-digit code from your authenticator app.' });
      let ok = verifyTotp(mfaCode, decrypt(user.mfaSecret));
      if (!ok) {
        const idx = matchBackupCode(mfaCode, user.mfaBackupCodes || []);
        if (idx >= 0) {
          const remaining = user.mfaBackupCodes.slice(); remaining.splice(idx, 1);
          users.update(user._id, { mfaBackupCodes: remaining });
          ok = true;
        }
      }
      if (!ok) {
        users.incLoginAttempts(user);
        logAction(req, 'auth.mfa_failed', { targetId: user._id });
        return res.status(401).json({ success: false, mfaRequired: true, message: 'Invalid authenticator code.' });
      }
    }

    users.resetLoginAttempts(user._id);
    const fresh = users.update(user._id, { lastLogin: new Date() });
    logAction(req, 'auth.login', { targetId: user._id });

    const token = signToken(fresh);
    res.json({
      success: true, token, user: users.toSafeJSON(fresh),
      pendingVerification: { email: !fresh.isEmailVerified, phone: !fresh.isPhoneVerified },
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ success: false, message: 'Login failed.' });
  }
});

// Shared OTP verification (F10: hashed compare, attempt cap, single-use).
function verifyOtpFlow(req, res, kind) {
  const isEmail = kind === 'email';
  const otpField = isEmail ? 'emailOtp' : 'phoneOtp';
  const expiryField = isEmail ? 'emailOtpExpiry' : 'phoneOtpExpiry';
  const attemptsField = isEmail ? 'emailOtpAttempts' : 'phoneOtpAttempts';
  const verifiedField = isEmail ? 'isEmailVerified' : 'isPhoneVerified';
  const label = isEmail ? 'Email' : 'Phone';

  const { otp } = req.body;
  const user = users.findById(req.user._id);

  if (user[verifiedField]) return res.json({ success: true, message: `${label} already verified.` });
  if (!user[otpField] || !user[expiryField] || user[expiryField].getTime() < Date.now()) {
    return res.status(400).json({ success: false, message: 'Code expired. Request a new one.' });
  }
  if ((user[attemptsField] || 0) >= MAX_OTP_ATTEMPTS) {
    users.update(user._id, { [otpField]: undefined, [expiryField]: undefined });
    return res.status(429).json({ success: false, message: 'Too many incorrect attempts. Request a new code.' });
  }

  const submittedHash = hashToken(String(otp || '').trim());
  if (!safeEqual(submittedHash, user[otpField])) {
    users.update(user._id, { [attemptsField]: (user[attemptsField] || 0) + 1 });
    return res.status(400).json({ success: false, message: 'Invalid code.' });
  }

  users.update(user._id, { [verifiedField]: true, [otpField]: undefined, [expiryField]: undefined, [attemptsField]: 0 });
  logAction(req, isEmail ? 'auth.verify_email' : 'auth.verify_phone', { targetId: user._id });
  res.json({ success: true, message: `${label} verified successfully.` });
}

router.post('/verify-email', protect, (req, res) => {
  try { verifyOtpFlow(req, res, 'email'); }
  catch (err) { console.error('Verify email error:', err.message); res.status(500).json({ success: false, message: 'Verification failed.' }); }
});
router.post('/verify-phone', protect, (req, res) => {
  try { verifyOtpFlow(req, res, 'phone'); }
  catch (err) { console.error('Verify phone error:', err.message); res.status(500).json({ success: false, message: 'Verification failed.' }); }
});

// POST /api/auth/resend-otp
router.post('/resend-otp', protect, async (req, res) => {
  try {
    const { type } = req.body;
    const user = users.findById(req.user._id);
    const otp = generateOTP();
    const expiry = new Date(Date.now() + OTP_EXPIRY);

    if (type === 'email') {
      if (user.isEmailVerified) return res.json({ success: true, message: 'Email already verified.' });
      users.update(user._id, { emailOtp: hashToken(otp), emailOtpExpiry: expiry, emailOtpAttempts: 0 });
      sendEmailOTP(user.email, otp, user.name).catch(e => console.error('Resend email OTP failed:', e.message));
    } else if (type === 'phone') {
      if (user.isPhoneVerified) return res.json({ success: true, message: 'Phone already verified.' });
      users.update(user._id, { phoneOtp: hashToken(otp), phoneOtpExpiry: expiry, phoneOtpAttempts: 0 });
      sendWhatsAppOTP(user.phone, otp).catch(e => console.error('Resend phone OTP failed:', e.message));
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
router.get('/me', protect, (req, res) => {
  const user = users.findById(req.user._id);
  res.json({ success: true, user: users.toSafeJSON(user) });
});

module.exports = router;
