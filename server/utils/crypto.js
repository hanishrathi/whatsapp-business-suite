const crypto = require('crypto');

/*
 * AES-256-GCM encryption for secrets at rest (e.g. WhatsApp access tokens).
 * Key comes from ENCRYPTION_KEY env var: a 64-char hex string (32 bytes).
 * Generate one with:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Stored format:  <iv_hex>:<authTag_hex>:<ciphertext_hex>
 */

const ALGO = 'aes-256-gcm';

function getKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'ENCRYPTION_KEY missing or invalid. It must be a 64-character hex string (32 bytes). ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(hex, 'hex');
}

// Encrypt a plaintext string -> storable string. Empty/falsy input returns ''.
function encrypt(plaintext) {
  if (plaintext === undefined || plaintext === null || plaintext === '') return '';
  const key = getKey();
  const iv = crypto.randomBytes(12); // 96-bit nonce for GCM
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

// Decrypt a stored string -> plaintext. Returns '' for empty input.
function decrypt(stored) {
  if (!stored) return '';
  // If it doesn't look like our format, assume legacy plaintext and return as-is.
  const parts = String(stored).split(':');
  if (parts.length !== 3) return stored;
  try {
    const key = getKey();
    const [ivHex, tagHex, dataHex] = parts;
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch (err) {
    // Tampered or wrong key — never leak the stored value.
    throw new Error('Failed to decrypt secret (key mismatch or data tampered).');
  }
}

// Hash a value (e.g. OTP) with SHA-256 for safe storage + constant-time compare.
function hashToken(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// Constant-time string comparison to avoid timing attacks.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = { encrypt, decrypt, hashToken, safeEqual };
