/* Shared test bootstrap — in-memory SQLite, no external services. */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('hex');
process.env.MAX_WHATSAPP_ACCOUNTS = '25';

const database = require('../server/config/database');
database.init(':memory:');                 // fresh in-memory DB for this test file

const app = require('../server/server');
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
