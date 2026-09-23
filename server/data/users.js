const bcrypt = require('bcryptjs');
const validator = require('validator');
const { getDb, newId } = require('../config/database');
const { toBool, fromBool, toDate, fromDate, toJson, fromJson, now } = require('./_map');

const SECRET_FIELDS = ['password', 'emailOtp', 'emailOtpExpiry', 'emailOtpAttempts',
  'phoneOtp', 'phoneOtpExpiry', 'phoneOtpAttempts', 'mfaSecret', 'mfaBackupCodes',
  'passwordResetToken', 'passwordResetExpiry'];

// Map a raw DB row -> rich JS object.
function mapRow(row) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    password: row.password,
    avatar: row.avatar || null,
    role: row.role,
    company: row.company || '',
    timezone: row.timezone,
    plan: row.plan,
    isEmailVerified: toBool(row.isEmailVerified),
    isPhoneVerified: toBool(row.isPhoneVerified),
    emailOtp: row.emailOtp || undefined,
    emailOtpExpiry: toDate(row.emailOtpExpiry),
    emailOtpAttempts: row.emailOtpAttempts || 0,
    phoneOtp: row.phoneOtp || undefined,
    phoneOtpExpiry: toDate(row.phoneOtpExpiry),
    phoneOtpAttempts: row.phoneOtpAttempts || 0,
    lastLogin: toDate(row.lastLogin),
    loginAttempts: row.loginAttempts || 0,
    lockUntil: toDate(row.lockUntil),
    tokenVersion: row.tokenVersion || 0,
    mfaEnabled: toBool(row.mfaEnabled),
    mfaSecret: row.mfaSecret || undefined,
    mfaBackupCodes: toJson(row.mfaBackupCodes, []),
    deleteRequestedAt: toDate(row.deleteRequestedAt),
    passwordResetToken: row.passwordResetToken || undefined,
    passwordResetExpiry: toDate(row.passwordResetExpiry),
    isActive: toBool(row.isActive),
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

// Validation mirroring the old Mongoose schema.
function validate({ name, email, phone, password }) {
  if (!name || name.trim().length < 2 || name.trim().length > 60) throw new Error('Name must be 2-60 characters');
  if (!email || !validator.isEmail(email)) throw new Error('Invalid email address');
  if (!phone || !String(phone).trim()) throw new Error('Phone number is required');
  if (!password || password.length < 8) throw new Error('Password must be at least 8 characters');
}

async function create({ name, email, phone, password, company }) {
  validate({ name, email, phone, password });
  const db = getDb();
  const id = newId();
  const ts = now();
  const hashed = await bcrypt.hash(password, 12);
  try {
    db.prepare(`INSERT INTO users (id,name,email,phone,password,company,createdAt,updatedAt)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, name.trim(), email.toLowerCase().trim(), String(phone).trim(), hashed, company || '', ts, ts);
  } catch (err) {
    if (/UNIQUE/i.test(err.message)) { const e = new Error('duplicate'); e.code = 11000; throw e; }
    throw err;
  }
  return mapRow(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

function findById(id) {
  return mapRow(getDb().prepare('SELECT * FROM users WHERE id = ?').get(id));
}
function findByEmail(email) {
  return mapRow(getDb().prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase().trim()));
}
function findByEmailOrPhone(email, phone) {
  return mapRow(getDb().prepare('SELECT * FROM users WHERE email = ? OR phone = ?')
    .get(String(email).toLowerCase().trim(), String(phone).trim()));
}

// Generic update. Accepts JS-typed values; converts to storage form.
function update(id, fields) {
  const db = getDb();
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (['isEmailVerified', 'isPhoneVerified', 'mfaEnabled', 'isActive'].includes(k)) out[k] = fromBool(v);
    else if (['emailOtpExpiry', 'phoneOtpExpiry', 'lastLogin', 'lockUntil', 'deleteRequestedAt', 'passwordResetExpiry'].includes(k)) out[k] = fromDate(v);
    else if (k === 'mfaBackupCodes') out[k] = fromJson(v);
    else if (v === undefined) out[k] = null;
    else out[k] = v;
  }
  const cols = Object.keys(out);
  if (!cols.length) return findById(id);
  const set = cols.map(c => `${c} = ?`).join(', ');
  db.prepare(`UPDATE users SET ${set}, updatedAt = ? WHERE id = ?`).run(...cols.map(c => out[c]), now(), id);
  return findById(id);
}

async function comparePassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// Set a new password (hashes it) and invalidate existing sessions.
async function setPassword(id, newPlain) {
  if (!newPlain || newPlain.length < 8) throw new Error('Password must be at least 8 characters');
  const hashed = await bcrypt.hash(newPlain, 12);
  const user = findById(id);
  getDb().prepare('UPDATE users SET password = ?, tokenVersion = ?, updatedAt = ? WHERE id = ?')
    .run(hashed, (user.tokenVersion || 0) + 1, now(), id);
  return findById(id);
}

/*
 * Look a user up by the SHA-256 hash of their reset token. The lookup is by
 * hash, so the raw token only ever exists in the email we sent.
 */
function findByResetTokenHash(hash) {
  if (!hash) return null;
  return mapRow(getDb().prepare(
    'SELECT * FROM users WHERE passwordResetToken = ? AND isActive = 1').get(hash));
}

function isLocked(user) {
  return !!(user.lockUntil && user.lockUntil.getTime() > Date.now());
}

function incLoginAttempts(user) {
  const db = getDb();
  if (user.lockUntil && user.lockUntil.getTime() < Date.now()) {
    db.prepare('UPDATE users SET loginAttempts = 1, lockUntil = NULL, updatedAt = ? WHERE id = ?').run(now(), user._id);
    return;
  }
  const attempts = (user.loginAttempts || 0) + 1;
  const lock = attempts >= 5 ? Date.now() + 15 * 60 * 1000 : null;
  db.prepare('UPDATE users SET loginAttempts = ?, lockUntil = ?, updatedAt = ? WHERE id = ?')
    .run(attempts, lock, now(), user._id);
}

function resetLoginAttempts(id) {
  getDb().prepare('UPDATE users SET loginAttempts = 0, lockUntil = NULL, updatedAt = ? WHERE id = ?').run(now(), id);
}

// Strip secrets for API responses.
function toSafeJSON(user) {
  if (!user) return null;
  const obj = { ...user };
  for (const f of SECRET_FIELDS) delete obj[f];
  obj.mfaEnabled = !!user.mfaEnabled;
  return obj;
}

module.exports = {
  create, findById, findByEmail, findByEmailOrPhone, findByResetTokenHash, update, setPassword,
  comparePassword, isLocked, incLoginAttempts, resetLoginAttempts, toSafeJSON, mapRow,
};
