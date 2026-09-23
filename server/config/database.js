const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

/*
 * SQLite database — self-hosted, single file, zero external services.
 *
 * The file lives at DATABASE_PATH. The default deliberately sits OUTSIDE the
 * application directory (../../whatsapp-suite-data relative to server/config),
 * because anything inside it risks being published by the static file server.
 * It previously defaulted to server/data/app.db, which the web server happily
 * served — WAL mode means app.db-wal holds the live rows, so the whole database
 * was downloadable over HTTP. Keep data out of any directory that is served.
 *
 * Tests pass ':memory:' for an ephemeral in-memory DB.
 */

let db;

function init(dbPath) {
  const target = dbPath || process.env.DATABASE_PATH
    || path.join(__dirname, '..', '..', '..', 'whatsapp-suite-data', 'app.db');

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
      passwordResetToken TEXT,
      passwordResetExpiry INTEGER,
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

    CREATE TABLE IF NOT EXISTS broadcast_messages (
      id TEXT PRIMARY KEY,
      broadcastId TEXT NOT NULL,
      userId TEXT NOT NULL,
      contactId TEXT,
      phone TEXT NOT NULL,
      wamid TEXT,
      status TEXT DEFAULT 'pending',
      error TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_bm_broadcast ON broadcast_messages(broadcastId);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_bm_wamid ON broadcast_messages(wamid) WHERE wamid IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ix_bm_user_time ON broadcast_messages(userId, createdAt);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      accountId TEXT,
      contactId TEXT,
      phone TEXT NOT NULL,
      direction TEXT NOT NULL,            -- 'in' | 'out'
      type TEXT DEFAULT 'text',           -- text | image | audio | document | ...
      body TEXT DEFAULT '',
      wamid TEXT,
      status TEXT DEFAULT 'received',     -- outbound: sent/delivered/read/failed
      error TEXT,
      errorCode INTEGER,
      -- Billing category at send time: service | marketing | utility | authentication.
      billingCategory TEXT DEFAULT '',
      isBillable INTEGER DEFAULT 0,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_msg_user_time ON messages(userId, createdAt);
    CREATE INDEX IF NOT EXISTS ix_msg_contact_time ON messages(contactId, createdAt);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_msg_wamid ON messages(wamid) WHERE wamid IS NOT NULL;

    /*
     * Daily snapshot of the state Meta owns and overwrites: quality rating,
     * messaging tier, ban state. Everything else on the Insights page is
     * derived from raw message rows, so it is NOT duplicated here — but these
     * three are external and are lost the moment Meta changes them.
     */
    CREATE TABLE IF NOT EXISTS account_health_snapshots (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      accountId TEXT NOT NULL,
      day TEXT NOT NULL,                  -- YYYY-MM-DD, UTC
      quality TEXT DEFAULT '',
      messagingLimit INTEGER,
      banState TEXT DEFAULT '',
      source TEXT DEFAULT 'poll',         -- 'poll' | 'webhook' | 'test'
      createdAt INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_health_day ON account_health_snapshots(accountId, day);
    CREATE INDEX IF NOT EXISTS ix_health_user_day ON account_health_snapshots(userId, day);

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

  runMigrations();
}

/*
 * Additive migrations. Every entry is `ALTER TABLE ... ADD COLUMN` with a
 * constant default, so re-running on an existing database is a no-op (SQLite
 * throws "duplicate column name", which we swallow). Never reorder or remove
 * entries — only append.
 */
const MIGRATIONS = [
  // Pre-existing.
  `ALTER TABLE broadcasts ADD COLUMN failedCount INTEGER DEFAULT 0`,

  // Consent: WhatsApp requires demonstrable opt-in before any business-initiated
  // message, and requires opt-out requests to be honoured.
  `ALTER TABLE contacts ADD COLUMN optInAt INTEGER`,
  `ALTER TABLE contacts ADD COLUMN optInSource TEXT DEFAULT ''`,
  `ALTER TABLE contacts ADD COLUMN optOutAt INTEGER`,
  `ALTER TABLE contacts ADD COLUMN optOutReason TEXT DEFAULT ''`,
  // Last inbound message from this contact — opens the 24h customer service window.
  `ALTER TABLE contacts ADD COLUMN lastInboundAt INTEGER`,

  // Channel model: 'cloud_api' accounts send through the WhatsApp Business
  // Platform; 'manual' accounts are WhatsApp Business app / regular WhatsApp
  // numbers that this app can only hand off to via click-to-chat.
  `ALTER TABLE whatsapp_accounts ADD COLUMN channelType TEXT DEFAULT 'cloud_api'`,
  // Messaging tier: unique recipients allowed per rolling 24h for
  // business-initiated conversations (250 / 1K / 10K / 100K / unlimited).
  // NULL means "not yet read from Meta". A fabricated default would either
  // block legitimate sends or give false confidence, so unknown stays unknown.
  `ALTER TABLE whatsapp_accounts ADD COLUMN messagingLimit INTEGER`,
  `ALTER TABLE whatsapp_accounts ADD COLUMN messagingLimitCheckedAt INTEGER`,

  // Templates are owned by Meta, not by us. These mirror the WABA record.
  `ALTER TABLE templates ADD COLUMN metaId TEXT DEFAULT ''`,
  `ALTER TABLE templates ADD COLUMN metaStatus TEXT DEFAULT ''`,
  `ALTER TABLE templates ADD COLUMN rejectedReason TEXT DEFAULT ''`,
  `ALTER TABLE templates ADD COLUMN components TEXT DEFAULT '[]'`,
  `ALTER TABLE templates ADD COLUMN syncedAt INTEGER`,
  `ALTER TABLE templates ADD COLUMN accountId TEXT`,

  // Per-recipient Meta error code, so failures can be triaged and retried sanely.
  `ALTER TABLE broadcast_messages ADD COLUMN errorCode INTEGER`,

  // Per-category consent. Someone who stops marketing may still want order
  // updates, so a marketing opt-out is tracked separately from a full one.
  `ALTER TABLE contacts ADD COLUMN marketingOptOutAt INTEGER`,

  // Quality + ban state pushed by Meta's account_update webhook.
  `ALTER TABLE whatsapp_accounts ADD COLUMN qualityUpdatedAt INTEGER`,
  `ALTER TABLE whatsapp_accounts ADD COLUMN banState TEXT DEFAULT ''`,

  // Billing category, so spend can be attributed once service messages
  // become billable on 2026-10-01.
  `ALTER TABLE broadcast_messages ADD COLUMN billingCategory TEXT DEFAULT ''`,

  // Which number sent it. Meta's messaging tier is per phone number, so the
  // rolling 24h recipient count has to be per account too — without this the
  // count was user-wide and compared against one account's limit.
  `ALTER TABLE broadcast_messages ADD COLUMN accountId TEXT`,

  // Why a run stopped early, so the operator can see it instead of it living
  // only in a server log.
  `ALTER TABLE broadcasts ADD COLUMN abortReason TEXT DEFAULT ''`,
  // Values for template variables beyond {{1}}, as JSON {"2":"...","3":"..."}.
  `ALTER TABLE broadcasts ADD COLUMN variables TEXT DEFAULT '{}'`,

  // Password reset. Only the SHA-256 hash of the token is stored, so a stolen
  // database snapshot cannot be used to reset anyone's password.
  `ALTER TABLE users ADD COLUMN passwordResetToken TEXT`,
  `ALTER TABLE users ADD COLUMN passwordResetExpiry INTEGER`,
];

function runMigrations() {
  for (const sql of MIGRATIONS) {
    try {
      db.exec(sql);
    } catch (err) {
      // "duplicate column name" means the migration already ran — anything else is real.
      if (!/duplicate column name/i.test(err.message)) throw err;
    }
  }
  db.exec(`CREATE INDEX IF NOT EXISTS ix_contacts_optin ON contacts(userId, optInAt)`);
  // Inbound webhooks look contacts up by digits-only phone; without this the
  // lookup was a full scan of the tenant's contacts on every message.
  db.exec(`CREATE INDEX IF NOT EXISTS ix_contacts_user_phone ON contacts(userId, phone)`);
  db.exec(`CREATE INDEX IF NOT EXISTS ix_bm_account_time ON broadcast_messages(accountId, createdAt)`);
  db.exec(`CREATE INDEX IF NOT EXISTS ix_msg_user_dir_time ON messages(userId, direction, createdAt)`);
  // Powers the rolling 24h unique-recipient check against the messaging tier.
  db.exec(`CREATE INDEX IF NOT EXISTS ix_bm_user_phone_time ON broadcast_messages(userId, phone, createdAt)`);
  // A WABA template is keyed by name+language, so duplicates are meaningless.
  // On a legacy database that already has duplicates this index can't be built;
  // warn rather than refusing to boot.
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_templates_user_name_lang
             ON templates(userId, name, language) WHERE isActive = 1`);
  } catch (err) {
    console.warn('Could not add unique template index (duplicate name+language rows exist). ' +
                 'De-duplicate your templates to enable it.');
  }
}

module.exports = { init, getDb, newId };
