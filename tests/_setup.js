/* Shared test bootstrap — in-memory SQLite, no external services. */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('hex');
process.env.MAX_WHATSAPP_ACCOUNTS = '25';

const database = require('../server/config/database');
database.init(':memory:');                 // fresh in-memory DB for this test file

/*
 * Requiring the server runs dotenv, which loads the developer's own .env.
 * Whatever it adds has to go, or the suite passes or fails depending on whose
 * machine it runs on. WA_APP_SECRET is the live example: with one set, every
 * webhook test posts an unsigned payload and gets a correct 403, so 14 tests
 * failed locally while CI — which has no .env — stayed green.
 *
 * Only keys dotenv introduced are removed. A test file that sets one itself
 * before requiring this module (sending.test.js sets WA_WEBHOOK_VERIFY_TOKEN)
 * keeps its value.
 */
const SENSITIVE = ['WA_APP_SECRET', 'WA_WEBHOOK_VERIFY_TOKEN', 'WA_GRAPH_BASE_URL', 'BASE_URL',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'];
const setByTest = new Set(SENSITIVE.filter(k => k in process.env));

const app = require('../server/server');

for (const key of SENSITIVE) {
  if (!setByTest.has(key)) delete process.env[key];
}

const users = require('../server/data/users');

function resetDb() {
  const db = database.getDb();
  for (const t of ['users', 'whatsapp_accounts', 'contacts', 'templates', 'broadcasts', 'broadcast_messages', 'messages', 'account_health_snapshots', 'audit_logs']) {
    db.exec(`DELETE FROM ${t}`);
  }
}

// Mark a user (by email) as fully verified.
function verifyUser(email) {
  const u = users.findByEmail(email);
  users.update(u._id, { isEmailVerified: true, isPhoneVerified: true });
  return u;
}

module.exports = { app, database, users, resetDb, verifyUser };
