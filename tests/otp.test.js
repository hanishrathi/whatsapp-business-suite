/*
 * When Meta refuses to send the WhatsApp sign-up code, the log has to say why
 * (a wrong template name, a missing parameter and an expired token all look the
 * same without it) — without ever writing the access token or the code itself.
 */
require('./_setup');
const { sendWhatsAppOTP } = require('../server/utils/otp');

const OTP = '482913';
const TOKEN = 'EAAG-secret-access-token';
let errors;

beforeEach(() => {
  process.env.WA_PHONE_NUMBER_ID = '1234567890';
  process.env.WA_ACCESS_TOKEN = TOKEN;
  errors = [];
  jest.spyOn(console, 'error').mockImplementation((...a) => errors.push(a.join(' ')));
});
afterEach(() => {
  delete process.env.WA_PHONE_NUMBER_ID;
  delete process.env.WA_ACCESS_TOKEN;
  delete global.fetch;
  jest.restoreAllMocks();
});

test("a refusal is logged with Meta's error code and message, minus the code and the token", async () => {
  global.fetch = jest.fn(async () => ({
    ok: false, status: 400,
    json: async () => ({ error: { code: 131008, error_subcode: 2388, message: `(#131008) Required parameter is missing: ${OTP}`, fbtrace_id: 'x' } }),
  }));
  await expect(sendWhatsAppOTP('+919000000000', OTP)).rejects.toThrow('WhatsApp message send failed.');

  const logged = errors.join('\n');
  expect(logged).toContain('HTTP status: 400');
  expect(logged).toContain('code 131008');
  expect(logged).toContain('subcode 2388');
  expect(logged).toContain('Required parameter is missing');
  expect(logged).not.toContain(OTP);
  expect(logged).not.toContain(TOKEN);
});

test('a refusal whose body is not JSON still logs the status and throws', async () => {
  global.fetch = jest.fn(async () => ({ ok: false, status: 502, json: async () => { throw new Error('not json'); } }));
  await expect(sendWhatsAppOTP('+919000000000', OTP)).rejects.toThrow('WhatsApp message send failed.');
  expect(errors.join('\n')).toContain('HTTP status: 502');
});

test('the code goes out in the body and in the URL button, in English', async () => {
  global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.1' }] }) }));
  await sendWhatsAppOTP('+91 90000-00000', OTP);
  const [url, init] = global.fetch.mock.calls[0];
  const sent = JSON.parse(init.body);
  expect(url).toContain('/1234567890/messages');
  expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  expect(sent.to).toBe('+919000000000');
  expect(sent.template.language.code).toBe('en');
  expect(sent.template.components[0].parameters[0].text).toBe(OTP);
  expect(sent.template.components[1]).toMatchObject({ type: 'button', sub_type: 'url', index: '0' });
  expect(sent.template.components[1].parameters[0].text).toBe(OTP);
});
