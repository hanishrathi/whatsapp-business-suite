/*
 * The spend estimator, against Meta's published billing rules:
 *   - only DELIVERED messages are charged ("Meta does not charge for messages sent");
 *   - each business phone number has its own free tier of 1,000 delivered
 *     service messages a month;
 *   - service messages became billable on 1 Oct 2026;
 *   - rate cards come in many currencies (INR included), so the currency is
 *     whatever the rates were written in, not a hard-coded dollar sign.
 */
const { database, resetDb } = require('./_setup');
const billing = require('../server/utils/billing');
const bmsgs = require('../server/data/broadcastMessages');

const AFTER_CUTOVER = Date.parse('2026-10-22T12:00:00Z');
const BEFORE_CUTOVER = Date.parse('2026-09-01T12:00:00Z');

const ENV_KEYS = ['WA_RATE_MARKETING', 'WA_RATE_UTILITY', 'WA_RATE_AUTHENTICATION', 'WA_RATE_SERVICE', 'WA_RATE_CURRENCY'];
let saved;
beforeEach(() => { saved = {}; for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  jest.restoreAllMocks();
});

describe('free tier is per business phone number', () => {
  test('1,000 free on each number, charged only above it', () => {
    jest.spyOn(Date, 'now').mockReturnValue(AFTER_CUTOVER);
    process.env.WA_RATE_UTILITY = '0.01';
    // three numbers: 1,500 / 400 / 1,000 delivered service messages
    const est = billing.estimate({ service: 2900 }, { serviceByAccount: [1500, 400, 1000] });
    const line = est.lines.find(l => l.category === 'service');
    expect(line.count).toBe(2900);
    expect(line.billableCount).toBe(500); // only the first number is over its 1,000
    expect(line.cost).toBe(5);
  });

  test('a single pool still gets one free tier (the older behaviour)', () => {
    jest.spyOn(Date, 'now').mockReturnValue(AFTER_CUTOVER);
    const est = billing.estimate({ service: 1500 });
    expect(est.lines[0].billableCount).toBe(500);
  });

  test('service messages are free before the 1 Oct 2026 cutover', () => {
    jest.spyOn(Date, 'now').mockReturnValue(BEFORE_CUTOVER);
    const est = billing.estimate({ service: 5000 }, { serviceByAccount: [5000] });
    expect(est.lines[0].billableCount).toBe(0);
    expect(est.total).toBe(0);
  });

  test('templates always bill, with no free tier', () => {
    jest.spyOn(Date, 'now').mockReturnValue(AFTER_CUTOVER);
    process.env.WA_RATE_MARKETING = '2';
    const est = billing.estimate({ marketing: 3 });
    expect(est.lines[0].billableCount).toBe(3);
    expect(est.total).toBe(6);
  });
});

describe('currency and rates', () => {
  test('defaults to USD placeholder rates and says so', () => {
    const est = billing.estimate({ marketing: 1 });
    expect(est.currency).toBe('USD');
    expect(est.usingDefaultRates).toBe(true);
  });

  test('takes the currency from WA_RATE_CURRENCY and notices when all rates are set', () => {
    process.env.WA_RATE_CURRENCY = 'inr';
    process.env.WA_RATE_MARKETING = '0.8631';
    process.env.WA_RATE_UTILITY = '0.115';
    process.env.WA_RATE_AUTHENTICATION = '0.115';
    const est = billing.estimate({ marketing: 10 });
    expect(est.currency).toBe('INR');
    expect(est.usingDefaultRates).toBe(false);
    expect(est.total).toBe(8.631);
  });

  test('a malformed currency falls back to USD instead of breaking the dashboard', () => {
    process.env.WA_RATE_CURRENCY = 'rupees';
    expect(billing.currency()).toBe('USD');
  });

  test('service is charged at the utility rate unless set on its own', () => {
    process.env.WA_RATE_UTILITY = '0.05';
    expect(billing.rates().service).toBe(0.05);
    process.env.WA_RATE_SERVICE = '0.07';
    expect(billing.rates().service).toBe(0.07);
  });

  test('formatMoney uses the right symbol and survives an unknown code', () => {
    expect(billing.formatMoney(1234.5, 'INR')).toContain('₹');
    expect(billing.formatMoney(1.5, 'USD')).toBe('$1.50');
    expect(billing.formatMoney(1.5, 'rupees')).toBe('rupees 1.50'); // malformed code: fallback, not a crash
  });
});

describe('counts come from delivered messages only', () => {
  afterEach(() => resetDb());

  const now = () => Date.now();
  function msg(id, { accountId = 'acc-1', direction = 'out', status, cat = 'service' }) {
    database.getDb().prepare(
      `INSERT INTO messages (id,userId,accountId,phone,direction,status,billingCategory,createdAt,updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?)`).run(id, 'u1', accountId, '+919000000000', direction, status, cat, now(), now());
  }
  function bm(id, { status, cat = 'marketing' }) {
    database.getDb().prepare(
      `INSERT INTO broadcast_messages (id,broadcastId,userId,phone,status,billingCategory,createdAt,updatedAt)
       VALUES (?,?,?,?,?,?,?,?)`).run(id, 'b1', 'u1', '+919000000000', status, cat, now(), now());
  }

  test('sent, failed and inbound messages are not billable; delivered and read are', () => {
    msg('m1', { status: 'delivered' });
    msg('m2', { status: 'read' });
    msg('m3', { status: 'sent' });
    msg('m4', { status: 'failed' });
    msg('m5', { status: 'received', direction: 'in' });
    bm('b1', { status: 'delivered' });
    bm('b2', { status: 'sent' });
    bm('b3', { status: 'read', cat: '' }); // sent before categories were tracked: counted as marketing

    const counts = bmsgs.billingCountsForUser('u1');
    expect(counts.service).toBe(2);
    expect(counts.marketing).toBe(2);
    expect(bmsgs.unconfirmedCountForUser('u1')).toBe(2); // m3 and b2
  });

  test('delivered service messages are grouped per business phone number', () => {
    for (let i = 0; i < 3; i++) msg(`a${i}`, { accountId: 'acc-1', status: 'delivered' });
    msg('b0', { accountId: 'acc-2', status: 'read' });
    msg('c0', { accountId: 'acc-2', status: 'sent' }); // unconfirmed: not in the count
    msg('d0', { accountId: 'acc-1', status: 'delivered', cat: 'utility' }); // not service

    expect(bmsgs.serviceCountsByAccountForUser('u1').sort()).toEqual([1, 3]);
  });
});
