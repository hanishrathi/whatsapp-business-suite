/* Insights: the derived signals, their severity, and the plain-English
   explanations. Also the health snapshot history, which is the one thing here
   that is separately collected rather than derived. */
const request = require('supertest');
const { app, resetDb, verifyUser } = require('./_setup');
const database = require('../server/config/database');
const health = require('../server/data/healthSnapshots');

const APPROVED = [{
  id: 't1', name: 'promo', status: 'APPROVED', category: 'MARKETING', language: 'en',
  components: [{ type: 'BODY', text: 'Hi {{1}}!' }],
}];

beforeEach(() => {
  global.fetch = jest.fn(async (url) => {
    const u = String(url);
    if (u.includes('/message_templates')) return { ok: true, status: 200, json: async () => ({ data: APPROVED }) };
    if (u.includes('/messages')) return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'w.' + Math.random() }] }) };
    return { ok: true, status: 200, json: async () => ({ display_phone_number: '+1', verified_name: 'B', quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K' }) };
  });
});
afterEach(() => { resetDb(); delete global.fetch; });

async function setup() {
  const reg = await request(app).post('/api/auth/register')
    .send({ name: 'Insights Owner', email: 'i@e.com', phone: '+919000009001', password: 'password123' });
  verifyUser('i@e.com');
  const auth = r => r.set('Authorization', `Bearer ${reg.body.token}`);
  const acc = await auth(request(app).post('/api/accounts'))
    .send({ name: 'Main', phone: '+919000009002', wabaId: 'W', phoneNumberId: '4440001', accessToken: 'tok' });
  return { auth, accountId: acc.body.account._id, userId: require('../server/data/users').findByEmail('i@e.com')._id };
}

const signal = (body, key) => body.insights.signals.find(s => s.key === key);

test('every signal explains what it is and what it does to the business', async () => {
  const { auth } = await setup();
  await auth(request(app).post('/api/contacts')).send({ name: 'A', phone: '+919811190001', optInSource: 'form' });

  const res = await auth(request(app).get('/api/insights'));
  expect(res.status).toBe(200);
  expect(res.body.insights.signals.length).toBeGreaterThan(0);
  for (const s of res.body.insights.signals) {
    expect(typeof s.what).toBe('string');
    expect(s.what.length).toBeGreaterThan(40);       // a real explanation, not a label
    expect(typeof s.impact).toBe('string');
    expect(s.impact.length).toBeGreaterThan(40);
    expect(['good', 'watch', 'act']).toContain(s.status);
    expect(s.display).toBeTruthy();
  }
});

test('a healthy account reports nothing to do; problems raise severity', async () => {
  const { auth } = await setup();
  await auth(request(app).post('/api/contacts')).send({ name: 'A', phone: '+919811190001', optInSource: 'form' });

  let res = await auth(request(app).get('/api/insights'));
  expect(signal(res.body, 'consent').status).toBe('good');
  expect(signal(res.body, 'consent').action).toBeNull();

  // A contact with no consent should downgrade coverage and give an action.
  await auth(request(app).post('/api/contacts')).send({ name: 'B', phone: '+919811190002' });
  res = await auth(request(app).get('/api/insights'));
  const consent = signal(res.body, 'consent');
  expect(consent.status).not.toBe('good');
  expect(consent.action).toContain('Record where consent came from');
  expect(consent.sub).toContain('1 contact has');   // singular reads correctly
});

test('opt-outs drive the opt-out signal to "act"', async () => {
  const { auth } = await setup();
  for (let i = 1; i <= 4; i++) {
    await auth(request(app).post('/api/contacts')).send({ name: 'C' + i, phone: '+91981119100' + i, optInSource: 'form' });
  }
  const list = await auth(request(app).get('/api/contacts'));
  await auth(request(app).post(`/api/contacts/${list.body.contacts[0]._id}/opt-out`)).send({ reason: 'stop' });

  const res = await auth(request(app).get('/api/insights'));
  const s = signal(res.body, 'optout');
  expect(s.value).toBe(25);          // 1 of 4
  expect(s.status).toBe('act');
  expect(s.action).toBeTruthy();
  expect(res.body.insights.overall).toBe('act');
  expect(res.body.insights.headline).toContain('opt-out rate');
});

test('failures are broken down by Meta reason code in plain English', async () => {
  const { auth, userId } = await setup();
  await auth(request(app).post('/api/contacts')).send({ name: 'A', phone: '+919811190001', optInSource: 'form' });
  const db = database.getDb();
  const bid = require('../server/data/broadcasts').create({
    userId, name: 'b', audienceTag: 'all', audienceCount: 1 })._id;
  const ins = db.prepare(`INSERT INTO broadcast_messages (id,broadcastId,userId,phone,status,error,errorCode,createdAt,updatedAt)
                          VALUES (?,?,?,?,'failed',?,?,?,?)`);
  const rid = () => require('crypto').randomBytes(12).toString('hex');
  for (let i = 0; i < 3; i++) ins.run(rid(), bid, userId, '+9198', 'undeliverable', 131026, Date.now(), Date.now());
  ins.run(rid(), bid, userId, '+9198', 'token', 190, Date.now(), Date.now());

  const res = await auth(request(app).get('/api/insights'));
  const s = signal(res.body, 'failures');
  expect(s.value).toBe(4);
  const codes = s.detail.breakdown.map(b => b.code);
  expect(codes).toContain(131026);
  const undeliverable = s.detail.breakdown.find(b => b.code === 131026);
  expect(undeliverable.count).toBe(3);
  expect(undeliverable.short).toBe('Number not reachable on WhatsApp');
  expect(undeliverable.cost).toBeTruthy();
  expect(undeliverable.fix).toBeTruthy();
  // The dominant cause is named in the summary line.
  expect(s.sub).toContain('Number not reachable');
});

test('health snapshots build a quality trend that a single reading cannot', async () => {
  const { auth, accountId, userId } = await setup();
  const db = database.getDb();
  const rid = () => require('crypto').randomBytes(12).toString('hex');
  const day = d => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
  const put = (d, q) => db.prepare(
    `INSERT OR REPLACE INTO account_health_snapshots (id,userId,accountId,day,quality,messagingLimit,banState,source,createdAt)
     VALUES (?,?,?,?,?,?,'','test',?)`).run(rid(), userId, accountId, day(d), q, 1000, Date.now());
  put(9, 'high'); put(4, 'medium'); put(0, 'low');

  const trend = health.qualityTrend(accountId);
  expect(trend.direction).toBe('falling');
  expect(trend.from).toBe('high');
  expect(trend.to).toBe('low');

  require('../server/data/whatsappAccounts').update(accountId, userId, { quality: 'low' });
  const res = await auth(request(app).get('/api/insights'));
  const s = signal(res.body, 'quality');
  expect(s.status).toBe('act');
  expect(s.sub).toContain('Falling');

  const hist = await auth(request(app).get('/api/insights/history'));
  expect(hist.status).toBe(200);
  expect(hist.body.accounts[0].history.length).toBe(3);
});

test('testing a connection records a health snapshot', async () => {
  const { auth, accountId } = await setup();
  expect(health.historyForAccount(accountId).length).toBe(0);
  await auth(request(app).post(`/api/accounts/${accountId}/test`));
  const hist = health.historyForAccount(accountId);
  expect(hist.length).toBe(1);
  expect(hist[0].messagingLimit).toBe(1000);
});

test('insights are scoped to the tenant', async () => {
  const { auth } = await setup();
  await auth(request(app).post('/api/contacts')).send({ name: 'Mine', phone: '+919811190001', optInSource: 'form' });

  const reg2 = await request(app).post('/api/auth/register')
    .send({ name: 'Other', email: 'o@e.com', phone: '+919000009009', password: 'password123' });
  verifyUser('o@e.com');
  const res = await request(app).get('/api/insights').set('Authorization', `Bearer ${reg2.body.token}`);
  // The other tenant sees its own (empty) consent picture, not ours.
  expect(signal(res.body, 'consent').detail.total).toBe(0);
});
