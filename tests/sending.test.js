/* End-to-end broadcast pipeline: send -> per-message tracking -> webhook receipts -> stats.
   Meta's API is mocked; everything else (DB, routes, sender) is real. */
process.env.WA_WEBHOOK_VERIFY_TOKEN = 'test-verify-token';

const request = require('supertest');
const { app, resetDb, verifyUser } = require('./_setup');
const sender = require('../server/services/sender');

let wamidCounter = 0;
beforeEach(() => {
  wamidCounter = 0;
  global.fetch = jest.fn(async (url, opts) => ({
    ok: true,
    status: 200,
    json: async () => {
      if (String(url).includes('/messages')) {
        return { messages: [{ id: `wamid.test.${++wamidCounter}` }] };
      }
      // testConnection profile call
      return { display_phone_number: '+91 98000 00000', verified_name: 'Test Biz', quality_rating: 'GREEN' };
    },
  }));
});
afterEach(() => { resetDb(); delete global.fetch; });

async function setupUserWithAccountAndContacts() {
  const reg = await request(app).post('/api/auth/register')
    .send({ name: 'Owner', email: 's@e.com', phone: '+919000003001', password: 'password123' });
  verifyUser('s@e.com');
  const token = reg.body.token;
  const auth = r => r.set('Authorization', `Bearer ${token}`);

  const acc = await auth(request(app).post('/api/accounts'))
    .send({ name: 'Main', phone: '+919000003002', phoneNumberId: '123456', accessToken: 'meta-token-abc' });
  expect(acc.status).toBe(201);

  await auth(request(app).post('/api/contacts')).send({ name: 'Asha', phone: '+919811110001' });
  await auth(request(app).post('/api/contacts')).send({ name: 'Ravi', phone: '+919811110002' });
  return { token, auth, accountId: acc.body.account._id };
}

test('broadcast actually sends to every active contact and tracks results', async () => {
  const { auth } = await setupUserWithAccountAndContacts();

  const created = await auth(request(app).post('/api/broadcasts'))
    .send({ name: 'Hello blast', message: 'Hi {{name}}, sale is on!' });
  expect(created.status).toBe(201);
  const id = created.body.broadcast._id;

  // Drive the sender directly so the test can await completion.
  const users = require('../server/data/users');
  const owner = users.findByEmail('s@e.com');
  const r = sender.sendNow(id, owner._id);
  expect(r.started).toBe(true);
  expect(r.audienceCount).toBe(2);
  await r.promise;

  const after = await auth(request(app).get(`/api/broadcasts/${id}`));
  expect(after.body.broadcast.status).toBe('sent');
  expect(after.body.broadcast.sentCount).toBe(2);
  expect(after.body.counts.sentTotal).toBe(2);

  // The Meta API was called once per contact, with personalized text.
  const messageCalls = global.fetch.mock.calls.filter(([u]) => String(u).includes('/messages'));
  expect(messageCalls).toHaveLength(2);
  const firstBody = JSON.parse(messageCalls[0][1].body);
  expect(firstBody.text.body).toContain('Asha');
});

test('send is refused without an account that has API credentials', async () => {
  const reg = await request(app).post('/api/auth/register')
    .send({ name: 'NoCreds', email: 'n@e.com', phone: '+919000003003', password: 'password123' });
  verifyUser('n@e.com');
  const auth = r => r.set('Authorization', `Bearer ${reg.body.token}`);
  await auth(request(app).post('/api/contacts')).send({ name: 'C', phone: '+919811110003' });
  const created = await auth(request(app).post('/api/broadcasts')).send({ name: 'B', message: 'hi' });

  const res = await auth(request(app).post(`/api/broadcasts/${created.body.broadcast._id}/send`));
  expect(res.status).toBe(400);
  expect(res.body.code).toBe('NO_ACCOUNT');
});

test('double-send is blocked and a sent broadcast cannot be resent', async () => {
  const { auth } = await setupUserWithAccountAndContacts();
  const created = await auth(request(app).post('/api/broadcasts')).send({ name: 'Once', message: 'hi' });
  const id = created.body.broadcast._id;

  const users = require('../server/data/users');
  const owner = users.findByEmail('s@e.com');
  const r = sender.sendNow(id, owner._id);
  await r.promise;

  const again = sender.sendNow(id, owner._id);
  expect(again.error).toBeTruthy();
  expect(again.code).toBe('DONE');
});

test('webhook delivery receipts advance message status and broadcast counters', async () => {
  const { auth } = await setupUserWithAccountAndContacts();
  const created = await auth(request(app).post('/api/broadcasts')).send({ name: 'Track', message: 'hi' });
  const id = created.body.broadcast._id;

  const users = require('../server/data/users');
  const owner = users.findByEmail('s@e.com');
  await sender.sendNow(id, owner._id).promise;

  // Meta posts a 'delivered' then 'read' receipt for the first message.
  const receipt = status => ({
    entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.test.1', status }] } }] }],
  });
  await request(app).post('/api/webhooks/whatsapp').send(receipt('delivered')).expect(200);
  await request(app).post('/api/webhooks/whatsapp').send(receipt('read')).expect(200);
  // A stale out-of-order 'delivered' must not downgrade 'read'.
  await request(app).post('/api/webhooks/whatsapp').send(receipt('delivered')).expect(200);

  const after = await auth(request(app).get(`/api/broadcasts/${id}`));
  expect(after.body.counts.read).toBe(1);
  expect(after.body.broadcast.readCount).toBe(1);
  expect(after.body.broadcast.deliveredCount).toBe(1); // read counts as delivered
});

test('webhook subscription handshake verifies the token', async () => {
  await request(app).get('/api/webhooks/whatsapp')
    .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'test-verify-token', 'hub.challenge': 'c123' })
    .expect(200, 'c123');
  await request(app).get('/api/webhooks/whatsapp')
    .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'c123' })
    .expect(403);
});

test('account test-connection verifies against Meta and updates status', async () => {
  const { auth, accountId } = await setupUserWithAccountAndContacts();
  const res = await auth(request(app).post(`/api/accounts/${accountId}/test`));
  expect(res.status).toBe(200);
  expect(res.body.message).toContain('Test Biz');

  const acc = await auth(request(app).get(`/api/accounts/${accountId}`));
  expect(acc.body.account.status).toBe('connected');
  expect(acc.body.account.isVerified).toBe(true);
});

test('CSV import adds rows, skips duplicates and junk; export round-trips', async () => {
  const { auth } = await setupUserWithAccountAndContacts(); // already has 2 contacts
  const res = await auth(request(app).post('/api/contacts/import')).send({
    contacts: [
      { name: 'New One', phone: '+919811120001', tags: 'vip' },
      { name: 'Asha', phone: '+919811110001' },     // duplicate phone
      { name: '', phone: '+919811120002' },          // missing name
      { name: 'New Two', phone: '+919811120003', email: 'two@e.com' },
    ],
  });
  expect(res.status).toBe(200);
  expect(res.body.added).toBe(2);
  expect(res.body.skipped).toBe(2);

  const csv = await auth(request(app).get('/api/contacts/export'));
  expect(csv.status).toBe(200);
  expect(csv.headers['content-type']).toContain('text/csv');
  expect(csv.text).toContain('New Two');
  expect(csv.text.split('\n')).toHaveLength(1 + 4); // header + 4 contacts
});

test('dashboard stats reflect real sends', async () => {
  const { auth } = await setupUserWithAccountAndContacts();
  const created = await auth(request(app).post('/api/broadcasts')).send({ name: 'S', message: 'hi' });
  const users = require('../server/data/users');
  const owner = users.findByEmail('s@e.com');
  await sender.sendNow(created.body.broadcast._id, owner._id).promise;

  const res = await auth(request(app).get('/api/dashboard/stats'));
  expect(res.status).toBe(200);
  const s = res.body.stats;
  expect(s.messagesToday).toBe(2);
  expect(s.totalContacts).toBe(2);
  expect(s.accountsConnected).toBe(1);
  expect(s.series).toHaveLength(7);
  expect(s.series[6].sent).toBe(2); // today is the last bucket
});

test('scheduled broadcast is picked up by the scheduler tick', async () => {
  const { auth } = await setupUserWithAccountAndContacts();
  const created = await auth(request(app).post('/api/broadcasts'))
    .send({ name: 'Later', message: 'hi', scheduledAt: new Date(Date.now() - 1000).toISOString() });
  expect(created.body.broadcast.status).toBe('scheduled');

  sender.tick(); // what the 30s interval runs
  // Give the async send a moment to finish (2 recipients, 1ms pacing in tests).
  await new Promise(r => setTimeout(r, 300));

  const after = await auth(request(app).get(`/api/broadcasts/${created.body.broadcast._id}`));
  expect(after.body.broadcast.status).toBe('sent');
  expect(after.body.broadcast.sentCount).toBe(2);
});
