/*
 * Regression guard for the static-file exposure found in the pre-launch audit.
 *
 * The app used to serve the whole project directory, which published the
 * server source, the .git directory and — because the database defaulted to
 * server/data/app.db — the SQLite file itself. In WAL mode the live rows sit in
 * app.db-wal, so every password hash and access token was downloadable over
 * HTTP without authentication. Only public/ may ever be served.
 */
const request = require('supertest');
const { app } = require('./_setup');

const MUST_NOT_BE_SERVED = [
  '/server/server.js',
  '/server/config/database.js',
  '/server/utils/crypto.js',
  '/server/data/app.db',
  '/server/data/app.db-wal',
  '/server/data/app.db-shm',
  '/tests/_setup.js',
  '/package.json',
  '/package-lock.json',
  '/.env',
  '/.env.example',
  '/.gitignore',
  '/.git/config',
  '/.git/HEAD',
  '/.git/index',
  '/CPANEL-DEPLOY.md',
  '/node_modules/express/package.json',
];

const MUST_BE_SERVED = [
  '/', '/login', '/register', '/verify', '/profile',
  '/css/dashboard.css', '/css/auth.css', '/js/api.js', '/js/util.js',
];

describe('Static file exposure', () => {
  test.each(MUST_NOT_BE_SERVED)('%s is not served', async (p) => {
    const res = await request(app).get(p);
    expect(res.status).toBe(404);
  });

  test('no response ever contains database or source content', async () => {
    for (const p of MUST_NOT_BE_SERVED) {
      const res = await request(app).get(p);
      const body = String(res.text || '');
      // Markers that would only appear if a real file were served.
      expect(body).not.toMatch(/SQLite format 3/);
      expect(body).not.toMatch(/require\('better-sqlite3'\)/);
      expect(body).not.toMatch(/\[remote "origin"\]/);
      expect(body).not.toMatch(/\$2[aby]\$\d\d\$/);   // bcrypt hash
    }
  });

  test.each(MUST_BE_SERVED)('%s is still served', async (p) => {
    const res = await request(app).get(p);
    expect(res.status).toBe(200);
  });
});
