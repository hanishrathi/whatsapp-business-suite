/* Proves the partial-unique-index fix: a soft-deleted phone can be re-added. */
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('hex');

let app, mongo, User, Contact, WhatsAppAccount;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../server/server');
  User = require('../server/models/User');
  Contact = require('../server/models/Contact');
  WhatsAppAccount = require('../server/models/WhatsAppAccount');
  // Ensure the partial unique indexes are actually built before we test them.
  await Promise.all([Contact.init(), WhatsAppAccount.init()]);
});
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) await c.deleteMany({});
});

async function verifiedToken(email, phone) {
  const reg = await request(app).post('/api/auth/register').send({ name: 'User', email, phone, password: 'password123' });
  await User.updateOne({ email }, { isEmailVerified: true, isPhoneVerified: true });
  return reg.body.token;
}

test('a deleted CONTACT phone can be re-added', async () => {
  const token = await verifiedToken('rc@e.com', '+919000001001');
  const phone = '+919811110000';
  const c1 = await request(app).post('/api/contacts').set('Authorization', `Bearer ${token}`).send({ name: 'A', phone });
  expect(c1.status).toBe(201);
  const del = await request(app).delete(`/api/contacts/${c1.body.contact._id}`).set('Authorization', `Bearer ${token}`);
  expect(del.status).toBe(200);
  // Re-adding the SAME phone must now succeed.
  const c2 = await request(app).post('/api/contacts').set('Authorization', `Bearer ${token}`).send({ name: 'A again', phone });
  expect(c2.status).toBe(201);
});

test('two active contacts with the same phone are still rejected', async () => {
  const token = await verifiedToken('rc2@e.com', '+919000001002');
  const phone = '+919811112222';
  await request(app).post('/api/contacts').set('Authorization', `Bearer ${token}`).send({ name: 'A', phone });
  const dup = await request(app).post('/api/contacts').set('Authorization', `Bearer ${token}`).send({ name: 'B', phone });
  expect(dup.status).toBe(409);
});

test('a deleted WHATSAPP ACCOUNT number can be re-added', async () => {
  const token = await verifiedToken('ra@e.com', '+919000001003');
  const phone = '+919800009999';
  const a1 = await request(app).post('/api/accounts').set('Authorization', `Bearer ${token}`).send({ name: 'Sales', phone });
  expect(a1.status).toBe(201);
  const del = await request(app).delete(`/api/accounts/${a1.body.account._id}`).set('Authorization', `Bearer ${token}`);
  expect(del.status).toBe(200);
  const a2 = await request(app).post('/api/accounts').set('Authorization', `Bearer ${token}`).send({ name: 'Sales 2', phone });
  expect(a2.status).toBe(201);
});
