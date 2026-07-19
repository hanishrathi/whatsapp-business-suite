// Load .env from the project root no matter where the process was started from.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const database = require('./config/database');

const app = express();
const PORT = process.env.PORT || 3000;

// Fail fast in production if critical secrets are missing — never boot insecure.
if (process.env.NODE_ENV === 'production') {
  const required = ['JWT_SECRET', 'ENCRYPTION_KEY'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`FATAL: missing required env vars in production: ${missing.join(', ')}`);
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
if (process.env.NODE_ENV !== 'test') {
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
      scriptSrc: ["'self'", "'unsafe-inline'"],
      // Fonts are now fully self-hosted — no third-party CDN allowed.
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
  origin: process.env.NODE_ENV === 'production'
    ? [process.env.BASE_URL, 'https://wa.acquihiretech.com', 'https://acquihiretech.com'].filter(Boolean)
    : '*',
  credentials: true,
}));

// Force HTTPS in production — but never redirect the health check (the platform
// probes it over HTTP internally) and only redirect safe GET/HEAD requests to
// avoid breaking POSTs or creating loops behind the proxy.
if (process.env.NODE_ENV === 'production') {
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
const skipInTest = () => process.env.NODE_ENV === 'test';

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
const staticOptions = process.env.NODE_ENV === 'production'
  ? { maxAge: '1d', etag: true }
  : {};

app.use(express.static(path.join(__dirname, '..'), staticOptions));
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { maxAge: '7d' }));

// API Routes
app.use('/api/auth', authLimiter, require('./routes/auth'));
app.use('/api/users', apiLimiter, require('./routes/users'));
app.use('/api/accounts', apiLimiter, require('./routes/accounts'));
app.use('/api/contacts', apiLimiter, require('./routes/contacts'));
app.use('/api/templates', apiLimiter, require('./routes/templates'));
app.use('/api/broadcasts', apiLimiter, require('./routes/broadcasts'));
app.use('/api/dashboard', apiLimiter, require('./routes/dashboard'));

// Meta webhook — no auth (Meta calls it), generous limit (delivery receipts burst).
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false, skip: skipInTest,
});
app.use('/api/webhooks', webhookLimiter, require('./routes/webhooks'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'operational',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    env: process.env.NODE_ENV,
  });
});

// SPA routes — serve HTML pages
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, '..', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, '..', 'register.html')));
app.get('/verify', (req, res) => res.sendFile(path.join(__dirname, '..', 'verify.html')));
app.get('/profile', (req, res) => res.sendFile(path.join(__dirname, '..', 'profile.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'index.html')));

// 404 handler
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, message: 'API endpoint not found.' });
  }
  res.sendFile(path.join(__dirname, '..', 'index.html'));
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
    message: process.env.NODE_ENV === 'production'
      ? 'Something went wrong.'
      : err.message,
  });
});

// Don't bind a port during tests (supertest uses the app object directly).
if (process.env.NODE_ENV !== 'test') {
  // Fire due scheduled broadcasts while the app is running.
  require('./services/sender').startScheduler();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`
  ╔══════════════════════════════════════════════════════╗
  ║   WhatsApp Business Suite — AcquiHire Tech          ║
  ║   Running on port ${PORT} · ${process.env.NODE_ENV || 'development'}                  ║
  ║   ${process.env.BASE_URL || 'http://localhost:' + PORT}              ║
  ╚══════════════════════════════════════════════════════╝
  `);
  });
}

module.exports = app;
