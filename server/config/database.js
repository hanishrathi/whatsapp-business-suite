const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

/*
 * SQLite database — self-hosted, single file, zero external services.
 * In production the file lives at DATABASE_PATH (default: server/data/app.db).
 * Tests pass ':memory:' for an ephemeral in-memory DB.
 */

let db;

function init(dbPath) {
  const target = dbPath || process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'app.db');

  if (target !== ':memory:') {
    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(target);
  db.pragma('journal_mode = WAL');   // better concurrency
  db.pragma('foreign_keys = ON');
  createSchema();
  return db;
}

function getDb() {
  if (!db) init();
  return db;
}

// Mongo-style 24-char hex id so existing id handling keeps working.
function newId() {
  return crypto.randomBytes(12).toString('hex');
}

function createSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      password TEXT NOT NULL,
      avatar TEXT,
      role TEXT DEFAULT 'user',
      company TEXT DEFAULT '',
      timezone TEXT DEFAULT 'Asia/Kolkata',
      plan TEXT DEFAULT 'free',
      isEmailVerified INTEGER DEFAULT 0,
      isPhoneVerified INTEGER DEFAULT 0,
      emailOtp TEXT,
      emailOtpExpiry INTEGER,
      emailOtpAttempts INTEGER DEFAULT 0,
      phoneOtp TEXT,
      phoneOtpExpiry INTEGER,
      phoneOtpAttempts INTEGER DEFAULT 0,
      lastLogin INTEGER,
      loginAttempts INTEGER DEFAULT 0,
      lockUntil INTEGER,
      tokenVersion INTEGER DEFAULT 0,
      mfaEnabled INTEGER DEFAULT 0,
      mfaSecret TEXT,
      mfaBackupCodes TEXT DEFAULT '[]',
      deleteRequestedAt INTEGER,
      isActive INTEGER DEFAULT 1,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email ON users(email);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_users_phone ON users(phone);

    CREATE TABLE IF NOT EXISTS whatsapp_accounts (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      countryCode TEXT DEFAULT '+91',
      category TEXT DEFAULT 'general',
      categoryLabel TEXT DEFAULT 'General',
      color TEXT DEFAULT '#25D366',
      colorClass TEXT DEFAULT 'green',
      wabaId TEXT DEFAULT '',
      phoneNumberId TEXT DEFAULT '',
      accessToken TEXT DEFAULT '',
      status TEXT DEFAULT 'offline',
      quality TEXT DEFAULT 'high',
      qualityLabel TEXT DEFAULT 'High',
      totalMessages INTEGER DEFAULT 0,
      totalContacts INTEGER DEFAULT 0,
      deliveryRate TEXT DEFAULT '0%',
      messagesThisMonth INTEGER DEFAULT 0,
      isVerified INTEGER DEFAULT 0,
      verifiedAt INTEGER,
      isActive INTEGER DEFAULT 1,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_user_phone ON whatsapp_accounts(userId, phone) WHERE isActive = 1;
    CREATE INDEX IF NOT EXISTS ix_wa_user_active ON whatsapp_accounts(userId, isActive);

    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      notes TEXT DEFAULT '',
      accountId TEXT,
      status TEXT DEFAULT 'active',
      lastContacted INTEGER,
      isActive INTEGER DEFAULT 1,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_contacts_user_phone ON contacts(userId, phone) WHERE isActive = 1;
    CREATE INDEX IF NOT EXISTS ix_contacts_user_active ON contacts(userId, isActive);

    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT DEFAULT 'marketing',
      language TEXT DEFAULT 'en',
      body TEXT NOT NULL,
      status TEXT DEFAULT 'draft',
      variableCount INTEGER DEFAULT 0,
      timesUsed INTEGER DEFAULT 0,
      isActive INTEGER DEFAULT 1,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_templates_user_active ON templates(userId, isActive);

    CREATE TABLE IF NOT EXISTS broadcasts (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      name TEXT NOT NULL,
      accountId TEXT,
      templateId TEXT,
      message TEXT DEFAULT '',
      audienceTag TEXT DEFAULT 'all',
      audienceCount INTEGER DEFAULT 0,
      status TEXT DEFAULT 'draft',
      scheduledAt INTEGER,
      sentCount INTEGER DEFAULT 0,
      deliveredCount INTEGER DEFAULT 0,
      readCount INTEGER DEFAULT 0,
      isActive INTEGER DEFAULT 1,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_broadcasts_user_active ON broadcasts(userId, isActive);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      userId TEXT,
      actorEmail TEXT,
      action TEXT NOT NULL,
      targetId TEXT,
      ip TEXT,
      userAgent TEXT,
      meta TEXT,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_audit_user ON audit_logs(userId);
    CREATE INDEX IF NOT EXISTS ix_audit_action ON audit_logs(action);
  `);
}

module.exports = { init, getDb, newId };
