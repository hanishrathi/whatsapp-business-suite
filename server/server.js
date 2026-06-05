require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const connectDB = require('./config/db');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust Railway / Render proxy for HTTPS & rate-limiter
app.set('trust proxy', 1);

// Connect to MongoDB
connectDB();

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? [process.env.BASE_URL, 'https://wa.acquihiretech.com', 'https://acquihiretech.com']
    : '*',
  credentials: true,
}));

// Force HTTPS in production
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(301, `https://${req.hostname}${req.url}`);
    }
    next();
  });
}

// Rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Try again in 15 minutes.' },
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Rate limit exceeded.' },
});

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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
  console.error('Server error:', err);

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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ╔══════════════════════════════════════════════════════╗
  ║   WhatsApp Business Suite — AcquiHire Tech          ║
  ║   Running on port ${PORT} · ${process.env.NODE_ENV || 'development'}                  ║
  ║   ${process.env.BASE_URL || 'http://localhost:' + PORT}              ║
  ╚══════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
