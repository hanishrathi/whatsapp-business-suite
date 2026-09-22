/* End-to-end broadcast pipeline: send -> per-message tracking -> webhook receipts -> stats.
   Meta's API is mocked; everything else (DB, routes, sender) is real.

   These tests encode WhatsApp's rules, not just the plumbing:
   business-initiated messages must use an approved template, recipients must
   have opt-in, and opt-out must be honoured. */
process.env.WA_WEBHOOK_VERIFY_TOKEN = 'test-verify-token';

const request = require('supertest');
const { app, resetDb, verifyUser } = require('./_setup');
const sender = require('../server/services/sender');

// One approved template on the mock WABA.
const META_TEMPLATES = [{
  id: 'meta-tpl-1',
  name: 'sale_alert',
  status: 'APPROVED',
  category: 'MARKETING',
  language: 'en',
  components: [{ type: 'BODY', text: 'Hi {{1}}, sale is on!' }],
}];

let wamidCounter = 0;
function mockMeta({ templates = META_TEMPLATES, sendFails = null } = {}) {
  global.fetch = jest.fn(async (url) => {
    const u = String(url);
    if (u.includes('/message_templates')) {
      return { ok: true, status: 200, json: async () => ({ data: templates }) };
    }
    if (u.includes('/messages')) {
      if (sendFails) {
        return {
          ok: false, status: 400,
          json: async () => ({ error: { code: sendFails.code, message: sendFails.message } }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.test.${++wamidCounter}` }] }) };
    }
    // testConnection profile call
    return {
      ok: true, status: 200,
      json: async () => ({
        display_phone_number: '+91 98000 00000', verified_name: 'Test Biz',
        quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K',
      }),
    };
  });
}

beforeEach(() => { wamidCounter = 0; mockMeta(); });
afterEach(() => { resetDb(); delete global.fetch; });

async function setupUserWithAccountAndContacts(opts = {}) {
  const reg = await request(app).post('/api/auth/register')
    .send({ name: 'Owner', email: 's@e.com', phone: '+919000003001', password: 'password123' });
  verifyUser('s@e.com');
  const token = reg.body.token;
  const auth = r => r.set('Authorization', `Bearer ${token}`);

  const acc = await auth(request(app).post('/api/accounts'))
    .send({ name: 'Main', phone: '+919000003002', wabaId: '999', phoneNumberId: '123456', accessToken: 'meta-token-abc' });
  expect(acc.status).toBe(201);

  // Pull the approved template down from Meta — the only way it becomes sendable.
  const sync = await auth(request(app).post('/api/templates/sync')).send({ accountId: acc.body.account._id });
  expect(sync.status).toBe(200);
  const tpls = await auth(request(app).get('/api/templates'));
  const templateId = tpls.body.templates[0] && tpls.body.templates[0]._id;

  // Contacts need recorded consent or they are excluded from every audience.
  const optIn = opts.withOptIn === false ? {} : { optInSource: 'website signup form' };
  await auth(request(app).post('/api/contacts')).send({ name: 'Asha', phone: '+919811110001', ...optIn });
  await auth(request(app).post('/api/contacts')).send({ name: 'Ravi', phone: '+919811110002', ...optIn });

  return { token, auth, accountId: acc.body.account._id, templateId };
}

function owner() {
  return require('../server/data/users').findByEmail('s@e.com');
}

test('broadcast sends an approved template to every opted-in contact and tracks results', async () => {
  const { auth, templateId } = await setupUserWithAccountAndContacts();

  const created = await auth(request(app).post('/api/broadcasts'))
    .send({ name: 'Hello blast', templateId });
  expect(created.status).toBe(201);
  const id = created.body.broadcast._id;

  // Drive the sender directly so the test can await completion.
  const r = sender.sendNow(id, owner()._id);
  expect(r.started).toBe(true);
  expect(r.audienceCount).toBe(2);
  await r.promise;

  const after = await auth(request(app).get(`/api/broadcasts/${id}`));
  expect(after.body.broadcast.status).toBe('sent');
  expect(after.body.broadcast.sentCount).toBe(2);
  expect(after.body.counts.sentTotal).toBe(2);

  // Meta was called once per contact, as a template with the name substituted.
  const messageCalls = global.fetch.mock.calls.filter(([u]) => String(u).includes('/messages'));
  expect(messageCalls).toHaveLength(2);
  const firstBody = JSON.parse(messageCalls[0][1].body);
  expect(firstBody.type).toBe('template');
  expect(firstBody.template.name).toBe('sale_alert');
  expect(firstBody.template.components[0].parameters[0].text).toBe('Asha');
});

test('a free-form broadcast with no template is refused', async () => {
  const { auth } = await setupUserWithAccountAndContacts();
  const res = await auth(request(app).post('/api/broadcasts')).send({ name: 'Blast', message: 'Hi there!' });
  expect(res.status).toBe(400);
  expect(res.body.code).toBe('TEMPLATE_REQUIRED');
});

test('a template Meta has not approved cannot be sent', async () => {
  // Same WABA, but the template is still in review.
  mockMeta({ templates: [{ ...META_TEMPLATES[0], status: 'PENDING' }] });
  const { auth, templateId } = await setupUserWithAccountAndContacts();

  const created = await auth(request(app).post('/api/broadcasts')).send({ name: 'Early', templateId });
  expect(created.status).toBe(400);
  expect(created.body.code).toBe('TEMPLATE_NOT_APPROVED');
});

test('contacts without recorded opt-in are excluded from the audience', async () => {
  const { auth, templateId } = await setupUserWithAccountAndContacts({ withOptIn: false });

  const created = await auth(request(app).post('/api/broadcasts')).send({ name: 'NoConsent', templateId });
  expect(created.status).toBe(201);
  expect(created.body.audienceCount).toBe(0);
  expect(created.body.excluded).toBe(2);

  const r = sender.sendNow(created.body.broadcast._id, owner()._id);
  expect(r.code).toBe('NO_AUDIENCE');
  expect(r.error).toContain('opt-in');
});

test('recording opt-in makes a contact reachable again', async () => {
  const { auth, templateId } = await setupUserWithAccountAndContacts({ withOptIn: false });
  const list = await auth(request(app).get('/api/contacts'));
  const contactId = list.body.contacts[0]._id;

  // Source is mandatory — consent has to be demonstrable.
  const noSource = await auth(request(app).post(`/api/contacts/${contactId}/opt-in`)).send({});
  expect(noSource.status).toBe(400);

  const ok = await auth(request(app).post(`/api/contacts/${contactId}/opt-in`))
    .send({ source: 'signed order form' });
  expect(ok.status).toBe(200);

  const created = await auth(request(app).post('/api/broadcasts')).send({ name: 'Now', templateId });
  expect(created.body.audienceCount).toBe(1);
});

test('bulk opt-in rescues contacts that predate consent tracking', async () => {
  const { auth, templateId } = await setupUserWithAccountAndContacts({ withOptIn: false });

  // Opt one of them out first — a bulk backfill must never revive an opt-out.
  const list = await auth(request(app).get('/api/contacts'));
  await auth(request(app).post(`/api/contacts/${list.body.contacts[0]._id}/opt-out`)).send({ reason: 'asked' });

  const noSource = await auth(request(app).post('/api/contacts/opt-in-existing')).send({});
  expect(noSource.status).toBe(400);

  const res = await auth(request(app).post('/api/contacts/opt-in-existing'))
    .send({ source: 'opt-in checkbox on signup form since 2024' });
  expect(res.status).toBe(200);
  expect(res.body.updated).toBe(1); // the opted-out one is left alone

  const created = await auth(request(app).post('/api/broadcasts')).send({ name: 'Backfilled', templateId });
  expect(created.body.audienceCount).toBe(1);
});

test('an opted-out contact is dropped from the audience', async () => {
  const { auth, templateId } = await setupUserWithAccountAndContacts();
  const list = await auth(request(app).get('/api/contacts'));
  const contactId = list.body.contacts[0]._id;

  await auth(request(app).post(`/api/contacts/${contactId}/opt-out`)).send({ reason: 'asked to stop' });

  const created = await auth(request(app).post('/api/broadcasts')).send({ name: 'After', templateId });
  expect(created.body.audienceCount).toBe(1);
});

test('an inbound STOP unsubscribes the contact', async () => {
  const { auth, templateId } = await setupUserWithAccountAndContacts();

  await request(app).post('/api/webhooks/whatsapp').send({
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: '123456' },
          messages: [{ from: '919811110001', type: 'text', text: { body: 'STOP' } }],
        },
      }],
    }],
  }).expect(200);

  const list = await auth(request(app).get('/api/contacts'));
  const asha = list.body.contacts.find(c => c.name === 'Asha');
  expect(asha.status).toBe('unsubscribed');
  expect(asha.hasOptIn).toBe(false);

  // And they no longer receive anything.
  const created = await auth(request(app).post('/api/broadcasts')).send({ name: 'Post-stop', templateId });
  expect(created.body.audienceCount).toBe(1);
});

test('an inbound message opens the 24h service window', async () => {
  const { auth } = await setupUserWithAccountAndContacts();

  await request(app).post('/api/webhooks/whatsapp').send({
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: '123456' },
          messages: [{ from: '919811110001', type: 'text', text: { body: 'do you deliver to Pune?' } }],
        },
      }],
    }],
  }).expect(200);

  const list = await auth(request(app).get('/api/contacts'));
  const asha = list.body.contacts.find(c => c.name === 'Asha');
  expect(asha.serviceWindowOpen).toBe(true);
  expect(asha.status).toBe('active'); // a normal question is not an opt-out
});

test('send is refused without an account that has API credentials', async () => {
  const reg = await request(app).post('/api/auth/register')
    .send({ name: 'NoCreds', email: 'n@e.com', phone: '+919000003003', password: 'password123' });
  verifyUser('n@e.com');
  const auth = r => r.set('Authorization', `Bearer ${reg.body.token}`);
  await auth(request(app).post('/api/contacts')).send({ name: 'C', phone: '+919811110003', optInSource: 'form' });

  // With no Cloud API account there is no template to attach either, so the
  // broadcast is rejected before it can be sent.
  const created = await auth(request(app).post('/api/broadcasts')).send({ name: 'B', message: 'hi' });
  expect(created.status).toBe(400);
  expect(created.body.code).toBe('TEMPLATE_REQUIRED');
});

test('a manual channel refuses automated sending and offers click-to-chat instead', async () => {
  const { auth } = await setupUserWithAccountAndContacts();

  const manual = await auth(request(app).post('/api/accounts'))
    .send({ name: 'Shop phone', phone: '+919000004444', channelType: 'manual' });
  expect(manual.status).toBe(201);
  expect(manual.body.account.canAutoSend).toBe(false);

  // Free-form text is allowed here — the operator types it into their own app.
  const created = await auth(request(app).post('/api/broadcasts'))
    .send({ name: 'Manual blast', message: 'Hi {{name}}, we are open!', accountId: manual.body.account._id });
  expect(created.status).toBe(201);

  const r = sender.sendNow(created.body.broadcast._id, owner()._id);
  expect(r.code).toBe('MANUAL_CHANNEL');

  const handoff = await auth(request(app).get(`/api/broadcasts/${created.body.broadcast._id}/handoff`));
  expect(handoff.status).toBe(200);
  expect(handoff.body.count).toBe(2);
  expect(handoff.body.links[0].url).toContain('https://wa.me/919811110001');
  expect(decodeURIComponent(handoff.body.links[0].url)).toContain('Asha');
});

test('a manual channel cannot hold Cloud API credentials', async () => {
  const { auth } = await setupUserWithAccountAndContacts();
  const res = await auth(request(app).post('/api/accounts'))
    .send({ name: 'Bad', phone: '+919000005555', channelType: 'manual', phoneNumberId: '7777' });
  expect(res.status).toBe(400);
  expect(res.body.code).toBe('CHANNEL_CONFLICT');
});

test('an audience larger than the messaging tier is refused', async () => {
  const { auth, accountId, templateId } = await setupUserWithAccountAndContacts();
  // Drop the tier below the 2-contact audience.
  require('../server/data/whatsappAccounts').update(accountId, owner()._id, { messagingLimit: 1 });

  const created = await auth(request(app).post('/api/broadcasts')).send({ name: 'Too big', templateId, accountId });
  const r = sender.sendNow(created.body.broadcast._id, owner()._id);
  expect(r.code).toBe('OVER_TIER_LIMIT');
  expect(r.error).toContain('messaging tier');
});

test('a fatal Meta error aborts the run instead of burning the audience', async () => {
  const { auth, templateId } = await setupUserWithAccountAndContacts();
  // 131049: per-user marketing frequency cap — the rest will fail the same way.
  mockMeta({ sendFails: { code: 131049, message: 'Not delivered to maintain healthy ecosystem engagement.' } });

  const created = await auth(request(app).post('/api/broadcasts')).send({ name: 'Capped', templateId });
  const r = sender.sendNow(created.body.broadcast._id, owner()._id);
  const outcome = await r.promise;

  expect(outcome.sent).toBe(0);
  expect(outcome.failed).toBe(1);        // stopped after the first failure
  expect(outcome.abortReason).toBeTruthy();
  const messageCalls = global.fetch.mock.calls.filter(([u]) => String(u).includes('/messages'));
  expect(messageCalls).toHaveLength(1);  // did not try the second contact
});

test('retry resends transient failures but not permanent ones', async () => {
  const { auth, templateId } = await setupUserWithAccountAndContacts();
  // 130429 is a rate limit — transient, so retryable.
  mockMeta({ sendFails: { code: 130429, message: 'Cloud API message throughput reached.' } });
  const created = await auth(request(app).post('/api/broadcasts')).send({ name: 'Flaky', templateId });
  await sender.sendNow(created.body.broadcast._id, owner()._id).promise;

  // Meta recovers; the retry should go through.
  mockMeta();
  const r = sender.retryFailed(created.body.broadcast._id, owner()._id);
  expect(r.started).toBe(true);
  expect(r.retryCount).toBe(2);
  const outcome = await r.promise;
  expect(outcome.sent).toBe(2);
});

test('retry skips permanently failed recipients', async () => {
  const { auth, templateId } = await setupUserWithAccountAndContacts();
  // 131026 means the number is not reachable on WhatsApp — never retry it.
  mockMeta({ sendFails: { code: 131026, message: 'Message undeliverable.' } });
  const created = await auth(request(app).post('/api/broadcasts')).send({ name: 'Dead', templateId });
  await sender.sendNow(created.body.broadcast._id, owner()._id).promise;

  const r = sender.retryFailed(created.body.broadcast._id, owner()._id);
  expect(r.code).toBe('NOTHING_TO_RETRY');
});

test('double-send is blocked and a sent broadcast cannot be resent', async () => {
  const { auth, templateId } = await setupUserWithAccountAndContacts();
  const created = await auth(request(app).post('/api/broadcasts')).send({ name: 'Once', templateId });
  const id = created.body.broadcast._id;

  await sender.sendNow(id, owner()._id).promise;

  const again = sender.sendNow(id, owner()._id);
  expect(again.error).toBeTruthy();
  expect(again.code).toBe('DONE');
});

test('webhook delivery receipts advance message status and broadcast counters', async () => {
  const { auth, templateId } = await setupUserWithAccountAndContacts();
  const created = await auth(request(app).post('/api/broadcasts')).send({ name: 'Track', templateId });
  const id = created.body.broadcast._id;

  await sender.sendNow(id, owner()._id).promise;

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

test('account test-connection verifies against Meta and records the messaging tier', async () => {
  const { auth, accountId } = await setupUserWithAccountAndContacts();
  const res = await auth(request(app).post(`/api/accounts/${accountId}/test`));
  expect(res.status).toBe(200);
  expect(res.body.message).toContain('Test Biz');
  expect(res.body.messagingLimit).toBe(1000);

  const acc = await auth(request(app).get(`/api/accounts/${accountId}`));
  expect(acc.body.account.status).toBe('connected');
  expect(acc.body.account.isVerified).toBe(true);
  expect(acc.body.account.messagingLimit).toBe(1000);
});

test('template sync mirrors Meta and refuses local approval', async () => {
  const { auth } = await setupUserWithAccountAndContacts();
  const list = await auth(request(app).get('/api/templates'));
  const tpl = list.body.templates[0];
  expect(tpl.metaStatus).toBe('APPROVED');
  expect(tpl.isSendable).toBe(true);

  // Nobody can mark their own template approved.
  const res = await auth(request(app).put(`/api/templates/${tpl._id}`)).send({ status: 'approved' });
  expect(res.status).toBe(400);
  expect(res.body.code).toBe('STATUS_NOT_SETTABLE');
});

test('CSV import records consent for the list, and rejects unusable numbers', async () => {
  const { auth } = await setupUserWithAccountAndContacts(); // already has 2 contacts
  const res = await auth(request(app).post('/api/contacts/import')).send({
    optInSource: 'trade show sign-up sheet, Mar 2026',
    contacts: [
      { name: 'New One', phone: '+919811120001', tags: 'vip' },
      { name: 'Asha', phone: '+919811110001' },     // duplicate phone
      { name: '', phone: '+919811120002' },          // missing name
      { name: 'No Country Code', phone: '04455' },   // not deliverable
      { name: 'New Two', phone: '+919811120003', email: 'two@e.com' },
    ],
  });
  expect(res.status).toBe(200);
  expect(res.body.added).toBe(2);
  expect(res.body.skipped).toBe(3);
  expect(res.body.invalidPhone).toBe(1);
  expect(res.body.optInRecorded).toBe(true);

  const csv = await auth(request(app).get('/api/contacts/export'));
  expect(csv.status).toBe(200);
  expect(csv.headers['content-type']).toContain('text/csv');
  expect(csv.text).toContain('New Two');
  expect(csv.text).toContain('trade show sign-up sheet');   // consent is exported as evidence
  expect(csv.text.split('\n')).toHaveLength(1 + 4);         // header + 4 contacts
});

test('an import without a consent source leaves contacts unreachable', async () => {
  const { auth } = await setupUserWithAccountAndContacts();
  const res = await auth(request(app).post('/api/contacts/import'))
    .send({ contacts: [{ name: 'Cold Lead', phone: '+919811130001' }] });
  expect(res.body.added).toBe(1);
  expect(res.body.optInRecorded).toBe(false);
  expect(res.body.message).toContain('none are marked as opted in');

  // Audience is still just the 2 consenting contacts from setup.
  const created = await auth(request(app).post('/api/broadcasts'))
    .send({ name: 'Check', templateId: (await auth(request(app).get('/api/templates'))).body.templates[0]._id });
  expect(created.body.audienceCount).toBe(2);
});

test('dashboard stats reflect real sends', async () => {
  const { auth, templateId } = await setupUserWithAccountAndContacts();
  const created = await auth(request(app).post('/api/broadcasts')).send({ name: 'S', templateId });
  await sender.sendNow(created.body.broadcast._id, owner()._id).promise;

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
  const { auth, templateId } = await setupUserWithAccountAndContacts();
  const created = await auth(request(app).post('/api/broadcasts'))
    .send({ name: 'Later', templateId, scheduledAt: new Date(Date.now() - 1000).toISOString() });
  expect(created.body.broadcast.status).toBe('scheduled');

  sender.tick(); // what the 30s interval runs
  // Give the async send a moment to finish (2 recipients, 1ms pacing in tests).
  await new Promise(r => setTimeout(r, 300));

  const after = await auth(request(app).get(`/api/broadcasts/${created.body.broadcast._id}`));
  expect(after.body.broadcast.status).toBe('sent');
  expect(after.body.broadcast.sentCount).toBe(2);
});
