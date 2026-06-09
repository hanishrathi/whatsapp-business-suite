/* Integration tests for Contacts / Templates / Broadcasts CRUD + isolation. */
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('hex');

let app, mongo, User;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../server/server');
  User = require('../server/models/User');
});
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) await c.deleteMany({});
});

async function verifiedUser(email, phone) {
  const reg = await request(app).post('/api/auth/register')
    .send({ name: 'User', email, phone, password: 'password123' });
  await User.updateOne({ email }, { isEmailVerified: true, isPhoneVerified: true });
  return reg.body.token;
}

describe('Contacts CRUD', () => {
  test('create, list, update, delete', async () => {
    const token = await verifiedUser('c@e.com', '+919000000001');
    const create = await request(app).post('/api/contacts').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Jane', phone: '+919811111111', tags: 'vip, lead' });
    expect(create.status).toBe(201);
    expect(create.body.contact.tags).toEqual(['vip', 'lead']);

    const list = await request(app).get('/api/contacts').set('Authorization', `Bearer ${token}`);
    expect(list.body.count).toBe(1);

    const id = create.body.contact._id;
    const upd = await request(app).put(`/api/contacts/${id}`).set('Authorization', `Bearer ${token}`).send({ name: 'Jane D' });
    expect(upd.body.contact.name).toBe('Jane D');

    const del = await request(app).delete(`/api/contacts/${id}`).set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(200);
    const after = await request(app).get('/api/contacts').set('Authorization', `Bearer ${token}`);
    expect(after.body.count).toBe(0);
  });

  test('unverified user is blocked from creating contacts', async () => {
    const reg = await request(app).post('/api/auth/register').send({ name: 'User', email: 'u@e.com', phone: '+919000000002', password: 'password123' });
    const res = await request(app).post('/api/contacts').set('Authorization', `Bearer ${reg.body.token}`).send({ name: 'X', phone: '+1' });
    expect(res.status).toBe(403);
  });

  test('tenant isolation: user B cannot see user A contacts', async () => {
    const a = await verifiedUser('a@e.com', '+919000000003');
    const b = await verifiedUser('b@e.com', '+919000000004');
    await request(app).post('/api/contacts').set('Authorization', `Bearer ${a}`).send({ name: 'Secret', phone: '+919822222222' });
    const list = await request(app).get('/api/contacts').set('Authorization', `Bearer ${b}`);
    expect(list.body.count).toBe(0);
  });
});

describe('Templates CRUD', () => {
  test('create counts variables; delete works', async () => {
    const token = await verifiedUser('t@e.com', '+919000000005');
    const create = await request(app).post('/api/templates').set('Authorization', `Bearer ${token}`)
      .send({ name: 'order', body: 'Hi {{1}}, order {{2}} shipped. Thanks {{1}}!' });
    expect(create.status).toBe(201);
    expect(create.body.template.variableCount).toBe(2); // {{1}} and {{2}}, deduped

    const del = await request(app).delete(`/api/templates/${create.body.template._id}`).set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(200);
  });
});

describe('Broadcasts CRUD', () => {
  test('audience count reflects active contacts', async () => {
    const token = await verifiedUser('b2@e.com', '+919000000006');
    await request(app).post('/api/contacts').set('Authorization', `Bearer ${token}`).send({ name: 'C1', phone: '+919833333333' });
    await request(app).post('/api/contacts').set('Authorization', `Bearer ${token}`).send({ name: 'C2', phone: '+919844444444' });

    const create = await request(app).post('/api/broadcasts').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Blast', message: 'Hello!' });
    expect(create.status).toBe(201);
    expect(create.body.broadcast.audienceCount).toBe(2);
  });
});
