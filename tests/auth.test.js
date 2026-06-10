/* Integration tests — security-critical flows (SQLite-backed). */
const request = require('supertest');
const { authenticator } = require('otplib');
const { app, users, resetDb, verifyUser } = require('./_setup');
const { hashToken } = require('../server/utils/crypto');

afterEach(() => resetDb());

async function makeUser(overrides = {}, { verify = false } = {}) {
  const body = {
    name: 'Test User',
    email: overrides.email || 'test@example.com',
    phone: overrides.phone || '+919999900001',
    password: overrides.password || 'password123',
  };
  const res = await request(app).post('/api/auth/register').send(body);
  if (verify) verifyUser(body.email);
  return { token: res.body.token, body, res };
}

describe('Health', () => {
  test('health endpoint responds', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('Registration & enumeration (F11)', () => {
  test('registers a new user and returns a token', async () => {
    const { res } = await makeUser();
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
  });

  test('duplicate registration does NOT reveal which field exists', async () => {
    await makeUser();
    const dup = await request(app).post('/api/auth/register').send({
      name: 'Other', email: 'test@example.com', phone: '+919999900002', password: 'password123',
    });
    expect(dup.status).toBe(202);
    expect(JSON.stringify(dup.body).toLowerCase()).not.toContain('already exists');
  });

  test('rejects short passwords', async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'X', email: 'x@example.com', phone: '+919999900003', password: 'short',
    });
    expect(res.status).toBe(400);
  });
});

describe('Login', () => {
  test('wrong password is rejected with generic message', async () => {
    await makeUser();
    const res = await request(app).post('/api/auth/login').send({ email: 'test@example.com', password: 'wrongpass1' });
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/invalid email or password/i);
  });

  test('correct password logs in', async () => {
    await makeUser();
    const res = await request(app).post('/api/auth/login').send({ email: 'test@example.com', password: 'password123' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });
});

describe('OTP verification (F10)', () => {
  test('wrong OTP is rejected, correct OTP verifies', async () => {
    const { token, body } = await makeUser();
    const u = users.findByEmail(body.email);
    users.update(u._id, { emailOtp: hashToken('123456'), emailOtpExpiry: new Date(Date.now() + 60000), emailOtpAttempts: 0 });

    const bad = await request(app).post('/api/auth/verify-email').set('Authorization', `Bearer ${token}`).send({ otp: '000000' });
    expect(bad.status).toBe(400);

    const good = await request(app).post('/api/auth/verify-email').set('Authorization', `Bearer ${token}`).send({ otp: '123456' });
    expect(good.status).toBe(200);
  });

  test('OTP locks after too many attempts', async () => {
    const { token, body } = await makeUser();
    const u = users.findByEmail(body.email);
    users.update(u._id, { emailOtp: hashToken('123456'), emailOtpExpiry: new Date(Date.now() + 60000), emailOtpAttempts: 0 });
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/auth/verify-email').set('Authorization', `Bearer ${token}`).send({ otp: '000000' });
    }
    const locked = await request(app).post('/api/auth/verify-email').set('Authorization', `Bearer ${token}`).send({ otp: '123456' });
    expect(locked.status).toBe(429);
  });
});

describe('Session revocation (F5)', () => {
  test('password change invalidates old token', async () => {
    const { token } = await makeUser({}, { verify: true });
    const change = await request(app).put('/api/users/password').set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'password123', newPassword: 'newpassword123' });
    expect(change.status).toBe(200);
    const old = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(old.status).toBe(401);
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${change.body.token}`);
    expect(me.status).toBe(200);
  });
});

describe('Verification gate (F3)', () => {
  test('UNVERIFIED user cannot create a WhatsApp account', async () => {
    const { token } = await makeUser();
    const res = await request(app).post('/api/accounts').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Sales', phone: '+919800000001' });
    expect(res.status).toBe(403);
    expect(res.body.code).toMatch(/NOT_VERIFIED/);
  });

  test('VERIFIED user can create a WhatsApp account', async () => {
    const { token } = await makeUser({}, { verify: true });
    const res = await request(app).post('/api/accounts').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Sales', phone: '+919800000001' });
    expect(res.status).toBe(201);
    expect(res.body.account.name).toBe('Sales');
    expect(res.body.account.accessToken).toBeUndefined();
    expect(res.body.account.isVerified).toBe(false);
  });
});

describe('Tenant isolation (IDOR)', () => {
  test('user A cannot read user B account', async () => {
    const a = await makeUser({ email: 'a@example.com', phone: '+919811111111' }, { verify: true });
    const b = await makeUser({ email: 'b@example.com', phone: '+919822222222' }, { verify: true });
    const created = await request(app).post('/api/accounts').set('Authorization', `Bearer ${a.token}`)
      .send({ name: 'A-acct', phone: '+919800000009' });
    const id = created.body.account._id;
    const steal = await request(app).get(`/api/accounts/${id}`).set('Authorization', `Bearer ${b.token}`);
    expect(steal.status).toBe(404);
  });
});

describe('Token encryption at rest (F1)', () => {
  test('stored access token is encrypted, not plaintext', async () => {
    const { token } = await makeUser({}, { verify: true });
    const created = await request(app).post('/api/accounts').set('Authorization', `Bearer ${token}`)
      .send({ name: 'WithToken', phone: '+919800000010', wabaId: '123', accessToken: 'SECRET_TOKEN_VALUE' });
    const { database } = require('./_setup');
    const row = database.getDb().prepare('SELECT accessToken FROM whatsapp_accounts WHERE id = ?').get(created.body.account._id);
    expect(row.accessToken).not.toBe('SECRET_TOKEN_VALUE');
    expect(row.accessToken).toContain(':');
    const { decrypt } = require('../server/utils/crypto');
    expect(decrypt(row.accessToken)).toBe('SECRET_TOKEN_VALUE');
  });
});

describe('Account deletion frees email (F7)', () => {
  test('deleted user email can be reused', async () => {
    const { token } = await makeUser({ email: 'reuse@example.com', phone: '+919833333333' });
    verifyUser('reuse@example.com');
    const del = await request(app).delete('/api/users/account').set('Authorization', `Bearer ${token}`)
      .send({ password: 'password123' });
    expect(del.status).toBe(200);
    const again = await request(app).post('/api/auth/register').send({
      name: 'Reuser', email: 'reuse@example.com', phone: '+919844444444', password: 'password123',
    });
    expect(again.status).toBe(201);
  });
});

describe('MFA (F4)', () => {
  test('full enable + login-with-code flow', async () => {
    const { token, body } = await makeUser({}, { verify: true });
    const setup = await request(app).post('/api/users/mfa/setup').set('Authorization', `Bearer ${token}`).send({});
    expect(setup.body.secret).toBeTruthy();

    const code = authenticator.generate(setup.body.secret);
    const enable = await request(app).post('/api/users/mfa/enable').set('Authorization', `Bearer ${token}`).send({ code });
    expect(enable.status).toBe(200);
    expect(enable.body.backupCodes.length).toBeGreaterThan(0);

    const noCode = await request(app).post('/api/auth/login').send({ email: body.email, password: 'password123' });
    expect(noCode.status).toBe(206);
    expect(noCode.body.mfaRequired).toBe(true);

    const withCode = await request(app).post('/api/auth/login')
      .send({ email: body.email, password: 'password123', mfaCode: authenticator.generate(setup.body.secret) });
    expect(withCode.status).toBe(200);
    expect(withCode.body.token).toBeTruthy();
  });
});
