const { authenticator } = require('otplib');
const qrcode = require('qrcode');
const crypto = require('crypto');
const { hashToken, safeEqual } = require('./crypto');

// Allow a small clock-skew window (1 step before/after).
authenticator.options = { window: 1 };

// Generate a fresh base32 TOTP secret.
function generateSecret() {
  return authenticator.generateSecret();
}

// Build the otpauth:// URI + a QR data-URL the user scans in Google Authenticator/Authy.
async function buildEnrollment(secret, accountName) {
  const issuer = 'WhatsApp Suite';
  const otpauth = authenticator.keyuri(accountName, issuer, secret);
  const qrDataUrl = await qrcode.toDataURL(otpauth);
  return { otpauth, qrDataUrl, secret };
}

// Verify a 6-digit code against the secret.
function verifyToken(token, secret) {
  if (!token || !secret) return false;
  try {
    return authenticator.verify({ token: String(token).trim(), secret });
  } catch {
    return false;
  }
}

// Generate N single-use backup codes (returned in plaintext once, stored hashed).
function generateBackupCodes(count = 8) {
  const plain = [];
  const hashed = [];
  for (let i = 0; i < count; i++) {
    const code = crypto.randomBytes(5).toString('hex'); // 10 hex chars
    plain.push(code);
    hashed.push(hashToken(code));
  }
  return { plain, hashed };
}

// Check a submitted backup code against the stored hashes; returns the index used or -1.
function matchBackupCode(submitted, hashedList = []) {
  const submittedHash = hashToken(String(submitted).trim());
  for (let i = 0; i < hashedList.length; i++) {
    if (safeEqual(submittedHash, hashedList[i])) return i;
  }
  return -1;
}

module.exports = {
  generateSecret,
  buildEnrollment,
  verifyToken,
  generateBackupCodes,
  matchBackupCode,
};
