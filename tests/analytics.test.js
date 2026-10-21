/*
 * Google Analytics and the Meta Pixel on the sign-up funnel — and nowhere else.
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
  test.each(TRACKED)('%s loads js/analytics.js and its CSP allows GA4 and the Meta Pixel', async (p) => {
    const res = await request(app).get(p);
    expect(res.status).toBe(200);
    expect(res.text).toContain('js/analytics.js');
    expect(directive(res, 'script-src')).toContain('https://www.googletagmanager.com');
    expect(directive(res, 'script-src')).toContain('https://connect.facebook.net');
    expect(directive(res, 'connect-src')).toContain('https://*.google-analytics.com');
    expect(directive(res, 'connect-src')).toContain('https://www.facebook.com');
    expect(directive(res, 'img-src')).toContain('https://*.google-analytics.com');
    expect(directive(res, 'img-src')).toContain('https://www.facebook.com');
  });
});

describe('pages that must not be measured', () => {
  test.each(UNTRACKED)('%s has no tag and keeps its original CSP', async (p) => {
    const res = await request(app).get(p);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('analytics.js');
    for (const d of ['script-src', 'connect-src', 'img-src', 'frame-src', 'form-action']) {
      expect(directive(res, d)).not.toMatch(/google|facebook/i);
    }
  });
});

describe('search and AI indexing', () => {
  test.each([...TRACKED, ...UNTRACKED])('%s is marked noindex', async (p) => {
    const res = await request(app).get(p);
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
  });

  test('robots.txt is a real robots file that disallows everything', async () => {
    const res = await request(app).get('/robots.txt');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.text).toMatch(/User-agent: \*\s+Disallow: \/\s*$/m);
  });
});

describe('js/analytics.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'analytics.js'), 'utf8');

  function fakeStorage(initial = {}) {
    const data = { ...initial };
    return {
      data,
      getItem: (k) => (k in data ? data[k] : null),
      setItem: (k, v) => { data[k] = String(v); },
      removeItem: (k) => { delete data[k]; },
    };
  }

  // Runs the real file against a fake browser and returns what it queued.
  function run({ hostname = 'wa.acquihiretech.com', href, referrer = '', storage = fakeStorage() }) {
    const appended = [];
    const pathname = new URL(href).pathname;
    const sandbox = {
      URL,
      encodeURIComponent,
      window: { location: { hostname, href, pathname }, dataLayer: undefined, sessionStorage: storage },
      document: {
        referrer,
        head: { appendChild: (el) => appended.push(el) },
        createElement: () => ({}),
      },
    };
    vm.runInNewContext(src, sandbox);
    const plain = (a) => JSON.parse(JSON.stringify(Array.from(a)));
    const queue = (sandbox.window.dataLayer || []).map(plain);
    const pixel = sandbox.window.fbq ? sandbox.window.fbq.queue.map(plain) : null;
    return { queue, pixel, appended, window: sandbox.window, storage };
  }

  test('GA reports origin + path only — no query string, no fragment, in the page or the referrer', () => {
    const { queue, appended } = run({
      href: 'https://wa.acquihiretech.com/verify?token=SECRET&email=a@b.com#frag',
      referrer: 'https://wa.acquihiretech.com/login?next=/x&code=123',
    });
    const config = queue.find((e) => e[0] === 'config');
    expect(config[1]).toBe('G-XGCN7KZKVK');
    expect(config[2].page_location).toBe('https://wa.acquihiretech.com/verify');
    expect(config[2].page_referrer).toBe('https://wa.acquihiretech.com/login');
    expect(JSON.stringify(queue)).not.toMatch(/SECRET|a@b\.com|frag|code=123|next=/);
    expect(appended.map((el) => el.src)).toContain('https://www.googletagmanager.com/gtag/js?id=G-XGCN7KZKVK');
  });

  test('GA sends an empty referrer when there is none', () => {
    const { queue } = run({ href: 'https://wa.acquihiretech.com/login' });
    expect(queue.find((e) => e[0] === 'config')[2].page_referrer).toBe('');
  });

  test('the Meta Pixel loads with automatic configuration off and sends one PageView', () => {
    const { pixel, appended } = run({ href: 'https://wa.acquihiretech.com/register?utm_source=meta&fbclid=abc' });
    expect(appended.map((el) => el.src)).toContain('https://connect.facebook.net/en_US/fbevents.js');
    expect(pixel).toEqual([
      ['set', 'autoConfig', false, '1659929699486976'],
      ['init', '1659929699486976'],
      ['track', 'PageView'],
    ]);
  });

  test('the Meta Pixel stays off when the URL carries anything but campaign parameters', () => {
    const { pixel, appended, queue } = run({ href: 'https://wa.acquihiretech.com/login?token=SECRET' });
    expect(pixel).toBeNull();
    expect(appended.map((el) => el.src)).not.toContain('https://connect.facebook.net/en_US/fbevents.js');
    // GA still measures the page, with the query string stripped.
    expect(queue.find((e) => e[0] === 'config')[2].page_location).toBe('https://wa.acquihiretech.com/login');
  });

  test('a registration is counted once, on the /verify page load that follows it', () => {
    const storage = fakeStorage();
    const reg = run({ href: 'https://wa.acquihiretech.com/register', storage });
    reg.window.WAAnalytics.markRegistered();
    expect(storage.data.wa_registered).toBe('1');

    const first = run({ href: 'https://wa.acquihiretech.com/verify', storage });
    expect(first.queue).toContainEqual(['event', 'sign_up', { method: 'email' }]);
    expect(first.pixel).toContainEqual(['track', 'CompleteRegistration']);
    expect(storage.data.wa_registered).toBeUndefined();

    const again = run({ href: 'https://wa.acquihiretech.com/verify', storage });
    expect(again.queue.some((e) => e[1] === 'sign_up')).toBe(false);
    expect(again.pixel).not.toContainEqual(['track', 'CompleteRegistration']);
  });

  test('a visit to /verify without a fresh registration is not a sign-up', () => {
    const { queue, pixel } = run({ href: 'https://wa.acquihiretech.com/verify' });
    expect(queue.some((e) => e[1] === 'sign_up')).toBe(false);
    expect(pixel).not.toContainEqual(['track', 'CompleteRegistration']);
  });

  test.each(['acquihiretech.com', 'localhost', 'wa.example.com'])('does nothing on %s', (hostname) => {
    const { queue, pixel, appended, window } = run({ hostname, href: `https://${hostname}/login` });
    expect(queue).toEqual([]);
    expect(pixel).toBeNull();
    expect(appended).toEqual([]);
    expect(window.WAAnalytics).toBeUndefined();
  });

  test('uses the same GA4 Measurement ID and Meta Pixel as the marketing site', () => {
    expect(src).toContain("var GA_ID = 'G-XGCN7KZKVK';");
    expect(src).toContain("var PIXEL_ID = '1659929699486976';");
  });
});
