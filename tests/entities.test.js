/* Integration tests for Contacts / Templates / Broadcasts CRUD + isolation (SQLite). */
const request = require('supertest');
const { app, resetDb, verifyUser } = require('./_setup');

afterEach(() => resetDb());

async function verifiedToken(email, phone) {
  const reg = await request(app).post('/api/auth/register').send({ name: 'User', email, phone, password: 'password123' });
  verifyUser(email);
  return reg.body.token;
}

describe('Contacts CRUD', () => {
  test('create, list, update, delete', async () => {
    const token = await verifiedToken('c@e.com', '+919000000001');
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
    const a = await verifiedToken('a@e.com', '+919000000003');
    const b = await verifiedToken('b@e.com', '+919000000004');
    await request(app).post('/api/contacts').set('Authorization', `Bearer ${a}`).send({ name: 'Secret', phone: '+919822222222' });
    const list = await request(app).get('/api/contacts').set('Authorization', `Bearer ${b}`);
    expect(list.body.count).toBe(0);
  });
});

describe('Templates CRUD', () => {
  test('create counts variables; delete works', async () => {
    const token = await verifiedToken('t@e.com', '+919000000005');
    const create = await request(app).post('/api/templates').set('Authorization', `Bearer ${token}`)
      .send({ name: 'order', body: 'Hi {{1}}, order {{2}} shipped. Thanks {{1}}!' });
    expect(create.status).toBe(201);
    expect(create.body.template.variableCount).toBe(2);

    const del = await request(app).delete(`/api/templates/${create.body.template._id}`).set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(200);
  });
});

describe('Hardening: cross-tenant refs & status validation', () => {
  test("broadcast cannot reference another user's template", async () => {
    const a = await verifiedToken('ht1@e.com', '+919000002001');
    const b = await verifiedToken('ht2@e.com', '+919000002002');
    const tpl = await request(app).post('/api/templates').set('Authorization', `Bearer ${a}`)
      .send({ name: 'mine', body: 'hello' });
    const res = await request(app).post('/api/broadcasts').set('Authorization', `Bearer ${b}`)
      .send({ name: 'steal', templateId: tpl.body.template._id });
    expect(res.status).toBe(400);
  });

  test('broadcast status cannot be forced to "sent"', async () => {
    const token = await verifiedToken('ht3@e.com', '+919000002003');
    // A draft attached to a manual channel may carry free-form text — that is
    // the one case where no template is required, since the operator sends it.
    const acc = await request(app).post('/api/accounts').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Shop', phone: '+919000002093', channelType: 'manual' });
    const create = await request(app).post('/api/broadcasts').set('Authorization', `Bearer ${token}`)
      .send({ name: 'B', message: 'hi', accountId: acc.body.account._id });
    expect(create.status).toBe(201);
    const res = await request(app).put(`/api/broadcasts/${create.body.broadcast._id}`)
      .set('Authorization', `Bearer ${token}`).send({ status: 'sent' });
    expect(res.status).toBe(400);
  });

  test('contact with invalid status is rejected', async () => {
    const token = await verifiedToken('ht4@e.com', '+919000002004');
    const res = await request(app).post('/api/contacts').set('Authorization', `Bearer ${token}`)
      .send({ name: 'X', phone: '+919855555555', status: 'hacked' });
    expect(res.status).toBe(400);
  });
});

describe('Broadcasts CRUD', () => {
  test('audience count reflects opted-in contacts only', async () => {
    const token = await verifiedToken('b2@e.com', '+919000000006');
    const auth = r => r.set('Authorization', `Bearer ${token}`);
    await auth(request(app).post('/api/contacts')).send({ name: 'C1', phone: '+919833333333', optInSource: 'web form' });
    await auth(request(app).post('/api/contacts')).send({ name: 'C2', phone: '+919844444444', optInSource: 'web form' });
    // No consent recorded — must not be counted.
    await auth(request(app).post('/api/contacts')).send({ name: 'C3', phone: '+919855554444' });

    const acc = await auth(request(app).post('/api/accounts'))
      .send({ name: 'Shop', phone: '+919000000096', channelType: 'manual' });
    const create = await auth(request(app).post('/api/broadcasts'))
      .send({ name: 'Blast', message: 'Hello!', accountId: acc.body.account._id });
    expect(create.status).toBe(201);
    expect(create.body.broadcast.audienceCount).toBe(2);
    expect(create.body.excluded).toBe(1);
  });
});
