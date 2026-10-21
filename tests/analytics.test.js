/*
 * Google Analytics on the sign-up funnel — and nowhere else.
 *
 * js/analytics.js reports login, register and verify to the same GA4 property
 * as acquihiretech.com so a visit that starts on the marketing site and ends
 * in a registration is one journey. These tests pin down the three promises
 * that make that acceptable for an app whose signed-in side shows people's
 * customer conversations:
 *   1. only those three pages load it, and only those three pages get the
 *      Google hosts in their Content-Security-Policy;
 *   2. what it reports never carries a query string or fragment (the
 *      reset-password URL carries a token, and nothing else is left to chance);
 *   3. it does nothing off the production hostname.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const request = require('supertest');
const { app } = require('./_setup');

const TRACKED = ['/login', '/register', '/verify'];
const UNTRACKED = ['/', '/profile', '/reset-password'];

const directive = (res, name) =>
  (res.headers['content-security-policy'].split(';').map((d) => d.trim()).find((d) => d.startsWith(name + ' ')) || '');

describe('pages that are measured', () => {
  test.each(TRACKED)('%s loads js/analytics.js and its CSP allows GA4', async (p) => {
    const res = await request(app).get(p);
    expect(res.status).toBe(200);
    expect(res.text).toContain('js/analytics.js');
    expect(directive(res, 'script-src')).toContain('https://www.googletagmanager.com');
    expect(directive(res, 'connect-src')).toContain('https://*.google-analytics.com');
    expect(directive(res, 'img-src')).toContain('https://*.google-analytics.com');
  });
});

describe('pages that must not be measured', () => {
  test.each(UNTRACKED)('%s has no tag and keeps its original CSP', async (p) => {
    const res = await request(app).get(p);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('analytics.js');
    for (const d of ['script-src', 'connect-src', 'img-src']) {
      expect(directive(res, d)).not.toMatch(/google/i);
    }
  });
});

describe('js/analytics.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'analytics.js'), 'utf8');

  // Runs the real file against a fake browser and returns what it queued.
  function run({ hostname = 'wa.acquihiretech.com', href, referrer = '' }) {
    const appended = [];
    const sandbox = {
      URL,
      encodeURIComponent,
      window: { location: { hostname, href }, dataLayer: undefined },
      document: {
        referrer,
        head: { appendChild: (el) => appended.push(el) },
        createElement: () => ({}),
      },
    };
    vm.runInNewContext(src, sandbox);
    const queue = (sandbox.window.dataLayer || []).map((a) => JSON.parse(JSON.stringify(Array.from(a))));
    return { queue, appended };
  }

  test('reports origin + path only — no query string, no fragment, in the page or the referrer', () => {
    const { queue, appended } = run({
      href: 'https://wa.acquihiretech.com/verify?token=SECRET&email=a@b.com#frag',
      referrer: 'https://wa.acquihiretech.com/login?next=/x&code=123',
    });
    const config = queue.find((e) => e[0] === 'config');
    expect(config[1]).toBe('G-XGCN7KZKVK');
    expect(config[2].page_location).toBe('https://wa.acquihiretech.com/verify');
    expect(config[2].page_referrer).toBe('https://wa.acquihiretech.com/login');
    expect(JSON.stringify(queue)).not.toMatch(/SECRET|a@b\.com|frag|code=123|next=/);
    expect(appended).toHaveLength(1);
    expect(appended[0].src).toBe('https://www.googletagmanager.com/gtag/js?id=G-XGCN7KZKVK');
  });

  test('sends an empty referrer when there is none', () => {
    const { queue } = run({ href: 'https://wa.acquihiretech.com/login' });
    expect(queue.find((e) => e[0] === 'config')[2].page_referrer).toBe('');
  });

  test.each(['acquihiretech.com', 'localhost', 'wa.example.com'])('does nothing on %s', (hostname) => {
    const { queue, appended } = run({ hostname, href: `https://${hostname}/login` });
    expect(queue).toEqual([]);
    expect(appended).toEqual([]);
  });

  test('is the same Measurement ID as the marketing site', () => {
    expect(src).toContain("var GA_ID = 'G-XGCN7KZKVK';");
  });
});
