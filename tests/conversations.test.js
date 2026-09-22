/* Inbound message storage, the 24-hour customer service window, and the
   free-form reply path that the window gates. Meta's API is mocked. */
process.env.WA_WEBHOOK_VERIFY_TOKEN = 'test-verify-token';

const request = require('supertest');
const { app, resetDb, verifyUser } = require('./_setup');
const database = require('../server/config/database');

const APPROVED = [{
  id: 'meta-tpl-1', name: 'sale_alert', status: 'APPROVED', category: 'MARKETING',
  language: 'en', components: [{ type: 'BODY', text: 'Hi {{1}}, sale is on!' }],
}];

let wamidCounter = 0;
beforeEach(() => {
  wamidCounter = 0;
  global.fetch = jest.fn(async (url) => {
    const u = String(url);
    if (u.includes('/message_templates')) return { ok: true, status: 200, json: async () => ({ data: APPROVED }) };
    if (u.includes('/messages')) return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.out.${++wamidCounter}` }] }) };
    return { ok: true, status: 200, json: async () => ({ display_phone_number: '+91 98000 00000', verified_name: 'Test Biz', quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K' }) };
  });
});
afterEach(() => { resetDb(); delete global.fetch; });

async function setup() {
  const reg = await request(app).post('/api/auth/register')
    .send({ name: 'Owner', email: 'c@e.com', phone: '+919000005001', password: 'password123' });
  verifyUser('c@e.com');
  const auth = r => r.set('Authorization', `Bearer ${reg.body.token}`);
  const acc = await auth(request(app).post('/api/accounts'))
    .send({ name: 'Main', phone: '+919000005002', wabaId: '999', phoneNumberId: '123456', accessToken: 'tok' });
  await auth(request(app).post('/api/templates/sync')).send({ accountId: acc.body.account._id });
  const c = await auth(request(app).post('/api/contacts'))
    .send({ name: 'Asha', phone: '+919811110001', optInSource: 'web form' });
  return { auth, accountId: acc.body.account._id, contactId: c.body.contact._id };
}

// Deliver an inbound message through the webhook, as Meta would.
function inbound(body, { wamid = 'wamid.in.1', from = '919811110001', type = 'text' } = {}) {
  return request(app).post('/api/webhooks/whatsapp').send({
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: '123456' },
      messages: [{ from, id: wamid, type, ...(type === 'text' ? { text: { body } } : {}) }],
    } }] }],
  });
}

test('an inbound message is stored and appears in the conversation thread', async () => {
  const { auth, contactId } = await setup();
  await inbound('do you deliver to Pune?').expect(200);

  const list = await auth(request(app).get('/api/conversations'));
  expect(list.status).toBe(200);
  expect(list.body.conversations).toHaveLength(1);
  expect(list.body.conversations[0].lastMessage).toBe('do you deliver to Pune?');
  expect(list.body.conversations[0].serviceWindowOpen).toBe(true);

  const thread = await auth(request(app).get(`/api/conversations/${contactId}`));
  expect(thread.body.messages).toHaveLength(1);
  expect(thread.body.messages[0].direction).toBe('in');
  expect(thread.body.window.open).toBe(true);
});

test('a redelivered webhook does not duplicate the message', async () => {
  const { auth, contactId } = await setup();
  await inbound('hello', { wamid: 'wamid.dupe' }).expect(200);
  await inbound('hello', { wamid: 'wamid.dupe' }).expect(200);

  const thread = await auth(request(app).get(`/api/conversations/${contactId}`));
  expect(thread.body.messages).toHaveLength(1);
});

test('a free-form reply is allowed inside the 24h window', async () => {
  const { auth, contactId } = await setup();
  await inbound('is this in stock?').expect(200);

  const res = await auth(request(app).post(`/api/conversations/${contactId}/reply`))
    .send({ body: 'Yes, we have it in stock.' });
  expect(res.status).toBe(201);
  expect(res.body.message.direction).toBe('out');
  expect(res.body.message.billingCategory).toBe('service');

  const sendCalls = global.fetch.mock.calls.filter(([u]) => String(u).includes('/messages'));
  expect(sendCalls).toHaveLength(1);
  expect(JSON.parse(sendCalls[0][1].body).type).toBe('text'); // free-form, not a template
});

test('a free-form reply is refused when the window never opened', async () => {
  const { auth, contactId } = await setup();
  const res = await auth(request(app).post(`/api/conversations/${contactId}/reply`))
    .send({ body: 'Hello out of the blue' });
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('WINDOW_CLOSED');
  // Nothing was sent to Meta.
  expect(global.fetch.mock.calls.filter(([u]) => String(u).includes('/messages'))).toHaveLength(0);
});

test('a free-form reply is refused once the window has expired', async () => {
  const { auth, contactId } = await setup();
  await inbound('old question').expect(200);
  // Age the inbound message past 24 hours.
  database.getDb().prepare(`UPDATE messages SET createdAt = ? WHERE direction = 'in'`)
    .run(Date.now() - 25 * 60 * 60 * 1000);

  const res = await auth(request(app).post(`/api/conversations/${contactId}/reply`))
    .send({ body: 'Following up' });
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('WINDOW_CLOSED');
});

test('a reply is refused to a contact who opted out, even inside the window', async () => {
  const { auth, contactId } = await setup();
  await inbound('a question').expect(200);
  await auth(request(app).post(`/api/contacts/${contactId}/opt-out`)).send({ reason: 'asked' });

  const res = await auth(request(app).post(`/api/conversations/${contactId}/reply`))
    .send({ body: 'One more thing' });
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('OPTED_OUT');
});

test('a marketing opt-out stops marketing but leaves utility messages flowing', async () => {
  const { auth } = await setup();
  await inbound('stop promotions').expect(200);

  const list = await auth(request(app).get('/api/contacts'));
  const asha = list.body.contacts.find(c => c.name === 'Asha');
  expect(asha.marketingOptOutAt).toBeTruthy();
  expect(asha.acceptsMarketing).toBe(false);
  expect(asha.hasOptIn).toBe(true);       // still consents generally
  expect(asha.status).toBe('active');     // not a full unsubscribe

  // The MARKETING template now has nobody to send to.
  const tpls = await auth(request(app).get('/api/templates'));
  const created = await auth(request(app).post('/api/broadcasts'))
    .send({ name: 'Promo', templateId: tpls.body.templates[0]._id });
  expect(created.body.audienceCount).toBe(0);
});

test('account_update applies a quality downgrade and tier change', async () => {
  const { auth, accountId } = await setup();
  await request(app).post('/api/webhooks/whatsapp').send({
    entry: [{ changes: [{ field: 'account_update', value: {
      metadata: { phone_number_id: '123456' },
      current_limit: { quality_rating: 'RED' },
      messaging_limit_tier: 'TIER_250',
    } }] }],
  }).expect(200);

  const acc = await auth(request(app).get(`/api/accounts/${accountId}`));
  expect(acc.body.account.quality).toBe('low');
  expect(acc.body.account.messagingLimit).toBe(250);
});

test('account_update records a ban and marks the account errored', async () => {
  const { auth, accountId } = await setup();
  await request(app).post('/api/webhooks/whatsapp').send({
    entry: [{ changes: [{ field: 'account_update', value: {
      metadata: { phone_number_id: '123456' },
      ban_info: { waba_ban_state: 'DISABLED' },
    } }] }],
  }).expect(200);

  const acc = await auth(request(app).get(`/api/accounts/${accountId}`));
  expect(acc.body.account.status).toBe('error');
});

test('dashboard reports spend with service messages free until the Oct 2026 cutover', async () => {
  const { auth, contactId } = await setup();
  await inbound('hi').expect(200);
  await auth(request(app).post(`/api/conversations/${contactId}/reply`)).send({ body: 'hello back' });

  const res = await auth(request(app).get('/api/dashboard/stats'));
  const spend = res.body.stats.spend;
  expect(spend.counts.service).toBe(1);
  const serviceLine = spend.lines.find(l => l.category === 'service');
  // Before 2026-10-01 the message is counted but not charged.
  if (!spend.serviceBillingActive) {
    expect(serviceLine.billableCount).toBe(0);
    expect(spend.daysUntilServiceBilling).toBeGreaterThan(0);
  } else {
    expect(spend.serviceFreeAllowance).toBeGreaterThan(0);
  }
});
