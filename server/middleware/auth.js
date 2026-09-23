const jwt = require('jsonwebtoken');
const users = require('../data/users');

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
    // Pin the algorithm rather than accepting whatever the token claims.
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });

    const user = users.findById(decoded.id);
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

    // F5: reject tokens issued before a password change / logout-all.
    if ((decoded.tv || 0) !== (user.tokenVersion || 0)) {
      return res.status(401).json({
        success: false,
        message: 'Session expired. Please log in again.',
      });
    }

    // Strip secrets from the request-scoped user (routes re-fetch when they
    // genuinely need the password/MFA secret).
    req.user = users.toSafeJSON(user);
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

// Generate JWT. Accepts a user object (preferred) or a raw id (legacy).
function signToken(userOrId) {
  const isObj = userOrId && typeof userOrId === 'object';
  const id = isObj ? userOrId._id : userOrId;
  const tv = isObj ? (userOrId.tokenVersion || 0) : 0;
  return jwt.sign({ id, tv }, process.env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

module.exports = { protect, requireVerified, signToken };
