/*
 * The Terms and Privacy pages Meta's app settings point to
 * (wa.acquihiretech.com/terms and /policy). They must load without signing in,
 * stay free of analytics, and be linked from the sign-up form.
 */
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { app } = require('./_setup');

describe.each([['/terms', 'Terms of Service'], ['/policy', 'Privacy Policy']])('%s', (url, title) => {
  test('is public and shows its title', async () => {
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain(`<h1>${title}</h1>`);
  });

  test('loads no analytics or scripts', async () => {
    const res = await request(app).get(url);
    expect(res.text).not.toMatch(/<script/i);
  });
});

test('the sign-up form links to both pages', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'register.html'), 'utf8');
  expect(html).toContain('href="/terms"');
  expect(html).toContain('href="/policy"');
});
