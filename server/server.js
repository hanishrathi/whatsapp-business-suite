// Load .env from the project root no matter where the process was started from.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const database = require('./config/database');
const env = require('./config/env');

const app = express();
const PORT = process.env.PORT || 3000;

// Fail fast in production if critical secrets are missing — never boot insecure.
if (env.isUnrecognised) {
  console.warn(
    `WARNING: NODE_ENV is "${process.env.NODE_ENV || '(unset)'}", which is not recognised. ` +
    'Running in PRODUCTION mode. Set NODE_ENV=production explicitly, or "development"/"test" for a relaxed local run.'
  );
}

if (env.isProduction) {
  const required = ['JWT_SECRET', 'ENCRYPTION_KEY', 'WA_APP_SECRET'];
  const HELP = {
    JWT_SECRET: 'generate with: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"',
    ENCRYPTION_KEY: 'generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    WA_APP_SECRET: 'your Meta App Secret, from Meta App Dashboard -> Settings -> Basic. Required: it is what proves a webhook call came from Meta.',
  };
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error('FATAL: missing required environment variables in production:');
    for (const k of missing) console.error(`  - ${k}: ${HELP[k]}`);
    process.exit(1);
  }
  if (process.env.ENCRYPTION_KEY.length !== 64) {
    console.error('FATAL: ENCRYPTION_KEY must be a 64-character hex string (32 bytes).');
    process.exit(1);
  }
}

// Trust the cPanel/Passenger reverse proxy for HTTPS & rate-limiter
app.set('trust proxy', 1);

// Open the SQLite database + create schema (tests init their own in-memory DB).
if (!env.isTest) {
  database.init();
}

// Security middleware — F6: enable a working Content-Security-Policy.
// Allows the inline scripts/styles and Google Fonts the app actually uses,
// while blocking injected external scripts, framing (clickjacking), and plugins.
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      // All page scripts are external files (js/page-*.js), so inline script
      // is forbidden outright — that is what makes CSP worth having against XSS.
      scriptSrc: ["'self'"],
      scriptSrcAttr: ["'none'"],   // blocks onclick="" and friends
      // Inline STYLE is still allowed: the markup carries style="" attributes
      // throughout. Scripts are the XSS vector that matters here.
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
}));

app.use(cors({
  origin: env.isProduction
    ? [process.env.BASE_URL, 'https://wa.acquihiretech.com', 'https://acquihiretech.com'].filter(Boolean)
    : '*',
  credentials: true,
}));

// Force HTTPS in production — but never redirect the health check (the platform
// probes it over HTTP internally) and only redirect safe GET/HEAD requests to
// avoid breaking POSTs or creating loops behind the proxy.
if (env.isProduction) {
  app.use((req, res, next) => {
    const proto = req.headers['x-forwarded-proto'];
    const isSafe = req.method === 'GET' || req.method === 'HEAD';
    if (proto && proto !== 'https' && isSafe && req.path !== '/api/health') {
      return res.redirect(301, `https://${req.hostname}${req.url}`);
    }
    next();
  });
}

// Rate limiting (disabled under automated tests).
const skipInTest = () => env.isTest;

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: { success: false, message: 'Too many attempts. Try again in 15 minutes.' },
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: { success: false, message: 'Rate limit exceeded.' },
});

// Body parsing
// Keep the raw body so the Meta webhook signature can be verified.
app.use(express.json({ limit: '200kb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true, limit: '200kb' }));

// Static files — cache assets in production
/*
 * Serve ONLY the public asset directory. This used to serve the project root,
 * which published server source, package-lock.json, the .git directory and —
 * because DATABASE_PATH defaulted inside it — the SQLite database itself, with
 * every password hash and access token in it. dotfiles:'deny' is belt and
 * braces: serve-static's legacy default only checks the last path segment, so
 * /.git/config slipped through while /.env did not.
 */
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const staticOptions = {
  dotfiles: 'deny',
  index: false,
  ...(env.isProduction ? { maxAge: '1d', etag: true } : {}),
};

app.use(express.static(PUBLIC_DIR, staticOptions));
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { dotfiles: 'deny', index: false, maxAge: '7d' }));

// API Routes
app.use('/api/auth', authLimiter, require('./routes/auth'));
app.use('/api/users', apiLimiter, require('./routes/users'));
app.use('/api/accounts', apiLimiter, require('./routes/accounts'));
app.use('/api/contacts', apiLimiter, require('./routes/contacts'));
app.use('/api/templates', apiLimiter, require('./routes/templates'));
app.use('/api/broadcasts', apiLimiter, require('./routes/broadcasts'));
app.use('/api/conversations', apiLimiter, require('./routes/conversations'));
app.use('/api/dashboard', apiLimiter, require('./routes/dashboard'));
app.use('/api/insights', apiLimiter, require('./routes/insights'));

// Meta webhook — no auth (Meta calls it), generous limit (delivery receipts burst).
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false, skip: skipInTest,
});
app.use('/api/webhooks', webhookLimiter, require('./routes/webhooks'));

/*
 * Health check. This is what the cPanel keep-alive cron hits, so it has to
 * actually touch the database — a check that only proves Express is listening
 * would report "operational" over a corrupt or unreadable SQLite file.
 * It deliberately does not echo NODE_ENV or any other configuration.
 */
app.get('/api/health', (req, res) => {
  try {
    if (!env.isTest) database.getDb().prepare('SELECT 1').get();
    res.json({
      success: true,
      status: 'operational',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
    });
  } catch (err) {
    console.error('Health check failed:', err.message);
    res.status(503).json({
      success: false,
      status: 'degraded',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
    });
  }
});

// SPA routes — serve HTML pages
app.get('/login', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'register.html')));
app.get('/verify', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'verify.html')));
app.get('/profile', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'profile.html')));
app.get('/reset-password', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'reset-password.html')));
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// 404 handler
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, message: 'API endpoint not found.' });
  }
  /*
   * Only SPA-style paths fall through to index.html. Anything that looks like a
   * file gets an honest 404 — otherwise a request for /server/server.js answers
   * 200 with the dashboard, which hides the difference between "not served" and
   * "served" from anyone auditing this.
   */
  const segments = req.path.split('/').filter(Boolean);
  const looksLikeAFile = segments.length > 0 && segments[segments.length - 1].includes('.');
  const hidden = segments.some(seg => seg.startsWith('.'));
  if (looksLikeAFile || hidden) {
    return res.status(404).type('txt').send('Not found');
  }
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Error handler
app.use((err, req, res, next) => {
  // F16: log only the message, never full objects that may contain secrets/PII.
  console.error('Server error:', err.message);

  if (err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ success: false, message: 'File too large. Maximum 5MB.' });
    }
    return res.status(400).json({ success: false, message: err.message });
  }

  res.status(err.status || 500).json({
    success: false,
    message: env.isProduction
      ? 'Something went wrong.'
      : err.message,
  });
});

// Don't bind a port during tests (supertest uses the app object directly).
if (!env.isTest) {
  // Fire due scheduled broadcasts while the app is running.
  require('./services/sender').startScheduler();

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`
  ╔══════════════════════════════════════════════════════╗
  ║   WhatsApp Business Suite — AcquiHire Tech          ║
  ║   Running on port ${PORT} · ${env.isProduction ? 'production' : env.RAW}
  ║   ${process.env.BASE_URL || 'http://localhost:' + PORT}              ║
  ╚══════════════════════════════════════════════════════╝
  `);
  });

  /*
   * Shut down cleanly. Passenger sends SIGTERM on every restart and deploy;
   * without this the process is killed mid-request and the scheduler never
   * stops, so a broadcast tick can overlap the next boot.
   */
  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received — shutting down.`);
    require('./services/sender').stopScheduler();
    server.close(() => {
      try { database.getDb().close(); } catch (err) { /* already closed */ }
      process.exit(0);
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 10000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  /*
   * Log the reason before dying. The default behaviour prints a stack to stderr
   * and exits, which on cPanel means the cause is simply lost.
   */
  process.on('unhandledRejection', (reason) => {
    console.error('FATAL: unhandled promise rejection:', reason instanceof Error ? reason.message : reason);
    shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    console.error('FATAL: uncaught exception:', err.message);
    shutdown('uncaughtException');
  });
}

module.exports = app;
