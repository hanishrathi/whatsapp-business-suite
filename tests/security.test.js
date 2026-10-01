/* Guards for the auth/webhook hardening done in the pre-launch audit. */
const crypto = require('crypto');
const request = require('supertest');
const { app, resetDb, verifyUser, users } = require('./_setup');

afterEach(() => resetDb());

describe('Test environment is hermetic', () => {
  /*
   * The suite must not depend on what is in the developer's .env. It used to:
   * a local WA_APP_SECRET made 14 webhook tests fail while CI stayed green.
   */
  test('env vars that change behaviour do not leak in from a local .env', () => {
    for (const key of ['WA_APP_SECRET', 'WA_WEBHOOK_VERIFY_TOKEN', 'WA_GRAPH_BASE_URL', 'BASE_URL']) {
      expect(process.env[key]).toBeUndefined();
    }
  });
});

describe('Webhook signature verification', () => {
  const body = { object: 'whatsapp_business_account', entry: [] };

  afterEach(() => { delete process.env.WA_APP_SECRET; });

  test('rejects a payload with no signature when a secret is configured', async () => {
    process.env.WA_APP_SECRET = 'app-secret';
    const res = await request(app).post('/api/webhooks/whatsapp').send(body);
    expect(res.status).toBe(403);
  });

  test('rejects a payload with a wrong signature', async () => {
    process.env.WA_APP_SECRET = 'app-secret';
    const res = await request(app).post('/api/webhooks/whatsapp')
      .set('x-hub-signature-256', 'sha256=' + '0'.repeat(64))
      .send(body);
    expect(res.status).toBe(403);
  });

  test('accepts a correctly signed payload', async () => {
    process.env.WA_APP_SECRET = 'app-secret';
    const raw = JSON.stringify(body);
    const sig = 'sha256=' + crypto.createHmac('sha256', 'app-secret').update(raw).digest('hex');
    const res = await request(app).post('/api/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', sig)
      .send(raw);
    expect(res.status).toBe(200);
  });
});

describe('Environment handling', () => {
  test('an unrecognised NODE_ENV is treated as production, not development', () => {
    // Jest has its own module registry, so resetModules (not require.cache)
    // is what forces env.js to re-read NODE_ENV.
    const load = (value) => {
      const before = process.env.NODE_ENV;
      process.env.NODE_ENV = value;
      let mod;
      jest.isolateModules(() => { mod = require('../server/config/env'); });
      process.env.NODE_ENV = before;
      return mod;
    };
    for (const value of ['Production', 'prod', '', 'staging', 'PRODUCTION']) {
      expect(load(value).isProduction).toBe(true);
    }
    expect(load('development').isProduction).toBe(false);
    expect(load('test').isTest).toBe(true);
  });
});

describe('Account enumeration', () => {
  test('registering an existing email does not reveal that it exists', async () => {
    const payload = { name: 'First User', email: 'dup@e.com', phone: '+919000009001', password: 'password123' };
    const first = await request(app).post('/api/auth/register').send(payload);
    expect(first.status).toBe(201);

    const second = await request(app).post('/api/auth/register')
      .send({ ...payload, name: 'Second User', phone: '+919000009002' });

    expect(second.body.duplicate).toBeUndefined();
    expect(JSON.stringify(second.body)).not.toMatch(/exist|already|taken|duplicate/i);
  });
});

describe('Template category cannot bypass the marketing opt-out', () => {
  const { normaliseCategory, categoryOrSafeDefault } = require('../server/data/_constants');
  const contacts = require('../server/data/contacts');

  test('whitespace and case variants all normalise to marketing', () => {
    for (const v of ['marketing', ' marketing', 'MARKETING', 'Marketing ', '\tmarketing\n']) {
      expect(normaliseCategory(v)).toBe('marketing');
    }
  });

  test('an unknown category falls back to marketing, the most restrictive option', () => {
    for (const v of ['bogus', '', null, undefined, 'promo']) {
      expect(normaliseCategory(v)).toBeNull();
      expect(categoryOrSafeDefault(v)).toBe('marketing');
    }
  });

  test('a contact who opted out of marketing is excluded whatever the category spelling', async () => {
    const reg = await request(app).post('/api/auth/register')
      .send({ name: 'Cat Owner', email: 'cat@e.com', phone: '+919000007001', password: 'password123' });
    verifyUser('cat@e.com');
    const token = reg.body.token;

    const created = await request(app).post('/api/contacts').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Opted Out', phone: '+919000007002', optInSource: 'web form' });
    expect(created.status).toBe(201);
    const userId = users.findByEmail('cat@e.com')._id;

    // Opted in generally, but withdrew consent for promotions specifically.
    expect(contacts.recordMarketingOptOut(created.body.contact._id, userId)).toBe(true);

    for (const spelling of ['marketing', ' marketing', 'Marketing ', 'MARKETING']) {
      expect(contacts.countAudience(userId, 'all', spelling)).toBe(0);
    }
    // Utility still reaches them — a marketing opt-out is not a full opt-out.
    expect(contacts.countAudience(userId, 'all', 'utility')).toBe(1);
  });

  test('the API refuses an invalid template category instead of defaulting', async () => {
    const reg = await request(app).post('/api/auth/register')
      .send({ name: 'Cat Two', email: 'cat2@e.com', phone: '+919000007003', password: 'password123' });
    verifyUser('cat2@e.com');
    const token = reg.body.token;

    const bad = await request(app).post('/api/templates').set('Authorization', `Bearer ${token}`)
      .send({ name: 'sneaky', body: 'hello', category: ' marketing ' });
    expect(bad.status).toBe(201);
    expect(bad.body.template.category).toBe('marketing');

    const worse = await request(app).post('/api/templates').set('Authorization', `Bearer ${token}`)
      .send({ name: 'nope', body: 'hello', category: 'promotional' });
    expect(worse.status).toBe(400);
    expect(worse.body.code).toBe('INVALID_CATEGORY');
  });
});

describe('Password reset', () => {
  const crypto = require('crypto');
  const { hashToken } = require('../server/utils/crypto');

  async function makeUser(email, phone) {
    await request(app).post('/api/auth/register')
      .send({ name: 'Reset User', email, phone, password: 'password123' });
    verifyUser(email);
    return users.findByEmail(email);
  }

  test('forgot-password answers identically for known and unknown emails', async () => {
    await makeUser('reset1@e.com', '+919000008001');
    const known = await request(app).post('/api/auth/forgot-password').send({ email: 'reset1@e.com' });
    const unknown = await request(app).post('/api/auth/forgot-password').send({ email: 'nobody@e.com' });

    expect(known.status).toBe(unknown.status);
    expect(known.body).toEqual(unknown.body);
    expect(JSON.stringify(known.body)).not.toMatch(/token/i);
  });

  test('a reset token stores only its hash and lets the password be changed', async () => {
    const user = await makeUser('reset2@e.com', '+919000008002');
    await request(app).post('/api/auth/forgot-password').send({ email: 'reset2@e.com' });

    // Read the stored hash and forge the matching raw token the way the email would carry it.
    const row = require('../server/config/database').getDb()
      .prepare('SELECT passwordResetToken, passwordResetExpiry FROM users WHERE id = ?').get(user._id);
    expect(row.passwordResetToken).toMatch(/^[0-9a-f]{64}$/);   // a hash, not a token
    expect(row.passwordResetExpiry).toBeGreaterThan(Date.now());

    // Brute-force the raw token is impossible, so drive the endpoint with a known one.
    const raw = crypto.randomBytes(32).toString('hex');
    users.update(user._id, { passwordResetToken: hashToken(raw) });

    const res = await request(app).post('/api/auth/reset-password')
      .send({ token: raw, password: 'brandNewPass1' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();

    const login = await request(app).post('/api/auth/login')
      .send({ email: 'reset2@e.com', password: 'brandNewPass1' });
    expect(login.body.success).toBe(true);
  });

  test('a reset token is single use', async () => {
    const user = await makeUser('reset3@e.com', '+919000008003');
    const raw = crypto.randomBytes(32).toString('hex');
    users.update(user._id, {
      passwordResetToken: hashToken(raw),
      passwordResetExpiry: new Date(Date.now() + 60_000),
    });

    const first = await request(app).post('/api/auth/reset-password').send({ token: raw, password: 'firstPass123' });
    expect(first.status).toBe(200);

    const second = await request(app).post('/api/auth/reset-password').send({ token: raw, password: 'secondPass123' });
    expect(second.status).toBe(400);
    expect(second.body.code).toBe('INVALID_RESET_TOKEN');
  });

  test('an expired token is refused', async () => {
    const user = await makeUser('reset4@e.com', '+919000008004');
    const raw = crypto.randomBytes(32).toString('hex');
    users.update(user._id, {
      passwordResetToken: hashToken(raw),
      passwordResetExpiry: new Date(Date.now() - 1000),
    });
    const res = await request(app).post('/api/auth/reset-password').send({ token: raw, password: 'whatever123' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_RESET_TOKEN');
  });

  test('a garbage token is refused and a short password is rejected', async () => {
    const bad = await request(app).post('/api/auth/reset-password').send({ token: 'not-a-token', password: 'longenough1' });
    expect(bad.status).toBe(400);

    const user = await makeUser('reset5@e.com', '+919000008005');
    const raw = crypto.randomBytes(32).toString('hex');
    users.update(user._id, { passwordResetToken: hashToken(raw), passwordResetExpiry: new Date(Date.now() + 60_000) });
    const short = await request(app).post('/api/auth/reset-password').send({ token: raw, password: 'short' });
    expect(short.status).toBe(400);
    expect(short.body.message).toMatch(/8 characters/);
  });

  test('resetting a password invalidates existing sessions', async () => {
    const user = await makeUser('reset6@e.com', '+919000008006');
    const login = await request(app).post('/api/auth/login').send({ email: 'reset6@e.com', password: 'password123' });
    const oldToken = login.body.token;
    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${oldToken}`)).status).toBe(200);

    const raw = crypto.randomBytes(32).toString('hex');
    users.update(user._id, { passwordResetToken: hashToken(raw), passwordResetExpiry: new Date(Date.now() + 60_000) });
    await request(app).post('/api/auth/reset-password').send({ token: raw, password: 'rotatedPass123' });

    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${oldToken}`)).status).toBe(401);
  });

  test('the reset page and its script are served', async () => {
    expect((await request(app).get('/reset-password')).status).toBe(200);
    expect((await request(app).get('/js/page-reset-password.js')).status).toBe(200);
  });
});
