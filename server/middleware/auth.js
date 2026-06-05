const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Protect routes — require valid JWT
async function protect(req, res, next) {
  let token;

  // Check Authorization header
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Not authenticated. Please log in.',
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findById(decoded.id).select('-password');
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User no longer exists.',
      });
    }

    if (!user.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Account has been deactivated.',
      });
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token.',
    });
  }
}

// Require verified email + phone
function requireVerified(req, res, next) {
  if (!req.user.isEmailVerified) {
    return res.status(403).json({
      success: false,
      message: 'Email not verified. Please verify your email first.',
      code: 'EMAIL_NOT_VERIFIED',
    });
  }
  if (!req.user.isPhoneVerified) {
    return res.status(403).json({
      success: false,
      message: 'Phone not verified. Please verify your phone first.',
      code: 'PHONE_NOT_VERIFIED',
    });
  }
  next();
}

// Admin only
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Admin access required.',
    });
  }
  next();
}

// Generate JWT
function signToken(userId) {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

module.exports = { protect, requireVerified, adminOnly, signToken };
