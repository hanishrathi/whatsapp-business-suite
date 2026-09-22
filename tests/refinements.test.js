/* Regression tests for the issues found in review. Each one fails against the
   code as it was before the fix. */
const request = require('supertest');
const { app, resetDb, verifyUser } = require('./_setup');
const sender = require('../server/services/sender');
const database = require('../server/config/database');

const TPL_ONE_VAR = {
  id: 't1', name: 'one_var', status: 'APPROVED', category: 'MARKETING', language: 'en',
  components: [{ type: 'BODY', text: 'Hi {{1}}, sale is on!' }],
};
const TPL_THREE_VAR = {
  id: 't3', name: 'three_var', status: 'APPROVED', category: 'UTILITY', language: 'en',
  components: [{ type: 'BODY', text: 'Hi {{1}}, order {{2}} ships on {{3}}.' }],
};

let sendFails = null;
let tierField = 'TIER_1K';
function mockMeta(templates = [TPL_ONE_VAR]) {
  global.fetch = jest.fn(async (url) => {
    const u = String(url);
    if (u.includes('/message_templates')) return { ok: true, status: 200, json: async () => ({ data: templates }) };
    if (u.includes('/messages')) {
      if (sendFails) return { ok: false, status: 400, json: async () => ({ error: { code: sendFails, message: 'stub failure' } }) };
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'w.' + Math.random() }] }) };
    }
    const profile = { display_phone_number: '+1', verified_name: 'B', quality_rating: 'GREEN' };
    if (tierField) profile.messaging_limit_tier = tierField;
    return { ok: true, status: 200, json: async () => profile };
  });
}
beforeEach(() => { sendFails = null; tierField = 'TIER_1K'; mockMeta(); });
afterEach(() => { resetDb(); delete global.fetch; });

async function setup(templates) {
  if (templates) mockMeta(templates);
  const reg = await request(app).post('/api/auth/register')
    .send({ name: 'Refine Owner', email: 'r@e.com', phone: '+919000010001', password: 'password123' });
  verifyUser('r@e.com');
  const auth = r => r.set('Authorization', `Bearer ${reg.body.token}`);
  const acc = await auth(request(app).post('/api/accounts'))
    .send({ name: 'Main', phone: '+919000010002', wabaId: 'W', phoneNumberId: '5550001', accessToken: 'tok' });
  await auth(request(app).post('/api/templates/sync')).send({ accountId: acc.body.account._id });
  const tpls = await auth(request(app).get('/api/templates'));
  return {
    auth, accountId: acc.body.account._id,
    templateId: tpls.body.templates[0] && tpls.body.templates[0]._id,
    userId: require('../server/data/users').findByEmail('r@e.com')._id,
  };
}
const addContacts = async (auth, n, from = 1) => {
  for (let i = from; i < from + n; i++) {
    await auth(request(app).post('/api/contacts'))
      .send({ name: 'C' + i, phone: '+9198111' + String(10000 + i), optInSource: 'form' });
  }
};

test('retry reuses the existing rows instead of doubling the recipient count', async () => {
  const { auth, templateId } = await setup();
  await addContacts(auth, 2);
  sendFails = 130429;  // transient
  const created = await auth(request(app).post('/api/broadcasts')).send({ name: 'Flaky', templateId });
  await sender.sendNow(created.body.broadcast._id, require('../server/data/users').findByEmail('r@e.com')._id).promise;

  sendFails = null;
  const owner = require('../server/data/users').findByEmail('r@e.com')._id;
  const r = sender.retryFailed(created.body.broadcast._id, owner);
  expect(r.started).toBe(true);
  await r.promise;

  const after = await auth(request(app).get(`/api/broadcasts/${created.body.broadcast._id}`));
  // Two contacts means exactly two rows, however many times it was retried.
  expect(after.body.counts.total).toBe(2);
  expect(after.body.counts.pending).toBe(0);   // no phantom backlog
  expect(after.body.counts.sentTotal).toBe(2);
});

test('a contact who opts out then opts back in is reachable again', async () => {
  const { auth, templateId } = await setup();
  await addContacts(auth, 2);
  const list = await auth(request(app).get('/api/contacts'));
  const id = list.body.contacts[0]._id;

  await auth(request(app).post(`/api/contacts/${id}/opt-out`)).send({ reason: 'stop' });
  let b = await auth(request(app).post('/api/broadcasts')).send({ name: 'After stop', templateId });
  expect(b.body.audienceCount).toBe(1);

  await auth(request(app).post(`/api/contacts/${id}/opt-in`)).send({ source: 'asked to resume' });
  const refreshed = await auth(request(app).get('/api/contacts'));
  const c = refreshed.body.contacts.find(x => x._id === id);
  expect(c.status).toBe('active');       // the unsubscribe is lifted, not just optOutAt
  expect(c.hasOptIn).toBe(true);

  b = await auth(request(app).post('/api/broadcasts')).send({ name: 'After restart', templateId });
  expect(b.body.audienceCount).toBe(2);
});

test('an inbound START resubscribes someone who sent STOP', async () => {
  const { auth, templateId } = await setup();
  await addContacts(auth, 1);
  const inbound = (body, id) => request(app).post('/api/webhooks/whatsapp').send({
    entry: [{ changes: [{ value: { metadata: { phone_number_id: '5550001' },
      messages: [{ from: '919811110001', id, type: 'text', text: { body } }] } }] }],
  });
  await inbound('STOP', 'w.stop').expect(200);
  let b = await auth(request(app).post('/api/broadcasts')).send({ name: 'x', templateId });
  expect(b.body.audienceCount).toBe(0);

  await inbound('START', 'w.start').expect(200);
  b = await auth(request(app).post('/api/broadcasts')).send({ name: 'y', templateId });
  expect(b.body.audienceCount).toBe(1);
});

test('a template with unfilled variables is refused rather than sent blank', async () => {
  const { auth, templateId, userId } = await setup([TPL_THREE_VAR]);
  await addContacts(auth, 1);
  const created = await auth(request(app).post('/api/broadcasts')).send({ name: 'Three', templateId });

  const r = sender.sendNow(created.body.broadcast._id, userId);
  expect(r.code).toBe('MISSING_VARIABLES');
  expect(r.missing).toEqual([2, 3]);
  expect(global.fetch.mock.calls.filter(([u]) => String(u).includes('/messages'))).toHaveLength(0);

  // Supplying them lets it through, and the values reach Meta.
  await auth(request(app).put(`/api/broadcasts/${created.body.broadcast._id}`))
    .send({ variables: { 2: 'A-1234', 3: 'Friday' } });
  const ok = sender.sendNow(created.body.broadcast._id, userId);
  expect(ok.started).toBe(true);
  await ok.promise;
  const body = JSON.parse(global.fetch.mock.calls.filter(([u]) => String(u).includes('/messages'))[0][1].body);
  const params = body.template.components[0].parameters.map(p => p.text);
  expect(params).toEqual(['C1', 'A-1234', 'Friday']);
});

test('an unknown messaging tier does not become a fabricated 250 cap', async () => {
  tierField = null;                        // Meta omits the field
  const { auth, accountId, templateId, userId } = await setup();
  await addContacts(auth, 3);

  const test1 = await auth(request(app).post(`/api/accounts/${accountId}/test`));
  expect(test1.body.messagingLimit ?? null).toBeNull();
  expect(test1.body.message).toContain('did not report a messaging tier');
  const acc = await auth(request(app).get(`/api/accounts/${accountId}`));
  expect(acc.body.account.messagingLimit).toBeNull();
  expect(acc.body.account.messagingLimitKnown).toBe(false);

  // Unknown must not block the send.
  const created = await auth(request(app).post('/api/broadcasts')).send({ name: 'Go', templateId });
  const r = sender.sendNow(created.body.broadcast._id, userId);
  expect(r.started).toBe(true);
  await r.promise;
});

test('a known tier is not overwritten when a later check omits it', async () => {
  const { auth, accountId } = await setup();
  await auth(request(app).post(`/api/accounts/${accountId}/test`));
  let acc = await auth(request(app).get(`/api/accounts/${accountId}`));
  expect(acc.body.account.messagingLimit).toBe(1000);

  tierField = null;                        // Meta stops reporting it
  await auth(request(app).post(`/api/accounts/${accountId}/test`));
  acc = await auth(request(app).get(`/api/accounts/${accountId}`));
  expect(acc.body.account.messagingLimit).toBe(1000);   // not downgraded to 250
});

test('the tier cap is per account, not shared across numbers', async () => {
  const { auth, userId, templateId } = await setup();
  await addContacts(auth, 3);

  // A second Cloud API number with its own tier.
  const b = await auth(request(app).post('/api/accounts'))
    .send({ name: 'Second', phone: '+919000010003', wabaId: 'W2', phoneNumberId: '5550002', accessToken: 'tok' });
  const accounts = require('../server/data/whatsappAccounts');
  accounts.update(b.body.account._id, userId, { messagingLimit: 2 });

  // Fill the FIRST number's 24h window.
  const first = await auth(request(app).post('/api/broadcasts')).send({ name: 'First', templateId });
  await sender.sendNow(first.body.broadcast._id, userId).promise;

  // The second number has messaged nobody, so its own cap of 2 is what counts.
  const second = await auth(request(app).post('/api/broadcasts'))
    .send({ name: 'Second run', templateId, accountId: b.body.account._id });
  const r = sender.sendNow(second.body.broadcast._id, userId);
  expect(r.code).toBe('OVER_TIER_LIMIT');       // 3 contacts vs its own limit of 2
  expect(r.usedLast24h).toBe(0);                // not polluted by the other number
});

test('a retry is still subject to the tier cap', async () => {
  const { auth, accountId, userId, templateId } = await setup();
  await addContacts(auth, 3);
  sendFails = 130429;
  const created = await auth(request(app).post('/api/broadcasts')).send({ name: 'Cap', templateId, accountId });
  await sender.sendNow(created.body.broadcast._id, userId).promise;

  sendFails = null;
  require('../server/data/whatsappAccounts').update(accountId, userId, { messagingLimit: 1 });
  const r = sender.retryFailed(created.body.broadcast._id, userId);
  expect(r.code).toBe('OVER_TIER_LIMIT');
});

test('a scheduled broadcast blocked by the tier stays scheduled', async () => {
  const { auth, accountId, userId, templateId } = await setup();
  await addContacts(auth, 3);
  require('../server/data/whatsappAccounts').update(accountId, userId, { messagingLimit: 1 });

  const created = await auth(request(app).post('/api/broadcasts'))
    .send({ name: 'Later', templateId, accountId, scheduledAt: new Date(Date.now() - 1000).toISOString() });
  sender.tick();
  await new Promise(r => setTimeout(r, 200));

  const after = await auth(request(app).get(`/api/broadcasts/${created.body.broadcast._id}`));
  // Still scheduled, so it goes out once the window rolls forward.
  expect(after.body.broadcast.status).toBe('scheduled');
});

test('an aborted run is reported as failed with the reason, not as sent', async () => {
  const { auth, userId, templateId } = await setup();
  await addContacts(auth, 3);
  const created = await auth(request(app).post('/api/broadcasts')).send({ name: 'Abort', templateId });
  sendFails = 131049;   // fatal for the run
  const r = sender.sendNow(created.body.broadcast._id, userId);
  await r.promise;

  const after = await auth(request(app).get(`/api/broadcasts/${created.body.broadcast._id}`));
  expect(after.body.broadcast.status).toBe('failed');
  expect(after.body.broadcast.abortReason).toBeTruthy();
});

test('manual handoff honours a marketing opt-out', async () => {
  const { auth, userId, templateId } = await setup();   // template is MARKETING
  await addContacts(auth, 2);
  const manual = await auth(request(app).post('/api/accounts'))
    .send({ name: 'Shop', phone: '+919000010009', channelType: 'manual' });

  // One contact withdraws marketing consent only.
  await request(app).post('/api/webhooks/whatsapp').send({
    entry: [{ changes: [{ value: { metadata: { phone_number_id: '5550001' },
      messages: [{ from: '919811110001', id: 'w.m', type: 'text', text: { body: 'stop promotions' } }] } }] }],
  }).expect(200);

  const created = await auth(request(app).post('/api/broadcasts'))
    .send({ name: 'Promo', templateId, accountId: manual.body.account._id });
  const handoff = await auth(request(app).get(`/api/broadcasts/${created.body.broadcast._id}/handoff`));
  expect(handoff.body.count).toBe(1);
  expect(handoff.body.links.map(l => l.phone)).not.toContain('+919811110001');
});

test('inbound lookup finds contacts stored in either phone format', async () => {
  const { auth } = await setup();
  const contacts = require('../server/data/contacts');
  const userId = require('../server/data/users').findByEmail('r@e.com')._id;
  await auth(request(app).post('/api/contacts')).send({ name: 'Plus', phone: '+919811120001', optInSource: 'f' });
  // A contact written without the leading '+', as a legacy import might.
  database.getDb().prepare(
    `INSERT INTO contacts (id,userId,name,phone,optInAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)`)
    .run('c'.repeat(24), userId, 'Bare', '919811120002', Date.now(), Date.now(), Date.now());

  expect(contacts.findActiveByDigits(userId, '919811120001').name).toBe('Plus');
  expect(contacts.findActiveByDigits(userId, '919811120002').name).toBe('Bare');
  expect(contacts.findActiveByDigits(userId, '919999999999')).toBeNull();
});
