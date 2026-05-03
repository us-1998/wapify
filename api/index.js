// server.js — Wapify Main Entry Point
require('dotenv').config();
require('express-async-errors');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const logger = require('./config/logger');

const app = express();

// ── SECURITY MIDDLEWARE ──────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: [process.env.APP_URL, process.env.ADMIN_URL],
  credentials: true,
  methods: ['GET','POST','PUT','DELETE','PATCH','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
app.set('trust proxy', 1);

// ── RATE LIMITING ─────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  message: { error: 'Too many requests. Please try again later.' },
});
const authLimiter = rateLimit({
  windowMs: 900000, max: parseInt(process.env.LOGIN_RATE_LIMIT_MAX) || 5,
  message: { error: 'Too many login attempts. Please wait 15 minutes.' },
});
app.use('/api/', globalLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/admin/login', authLimiter);

// ── BODY PARSING ──────────────────────────────────────────────
// Raw body for Stripe + Meta webhooks BEFORE express.json()
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));
app.use('/api/whatsapp/webhook', express.raw({ type: 'application/json' }));
app.use('/api/stores/webhooks/shopify', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());
app.use(compression());

// ── LOGGING ───────────────────────────────────────────────────
app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }));

// ── API ROUTES ────────────────────────────────────────────────
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/stores',        require('./routes/stores'));
app.use('/api/orders',        require('./routes/orders'));
app.use('/api/conversations', require('./routes/conversations'));
app.use('/api/flows',         require('./routes/flows'));
app.use('/api/whatsapp',      require('./routes/whatsapp'));
app.use('/api/analytics',     require('./routes/analytics'));
app.use('/api/billing',       require('./routes/billing'));
app.use('/api/team',          require('./routes/team'));
app.use('/api/admin',         require('./routes/admin'));

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const { pool } = require('./config/db');
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
  } catch {
    res.status(503).json({ status: 'error', message: 'Database unavailable' });
  }
});

// ── SERVE FRONTEND ──────────────────────────────────────────
// Serve the static files from the 'public' directory
app.use(express.static(path.join(__dirname, '../public')));

// Handle Single Page Application (SPA) routing
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── GLOBAL ERROR HANDLER ──────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  if (err.name === 'ValidationError') return res.status(400).json({ error: err.message });
  if (err.code === '23505') return res.status(409).json({ error: 'Resource already exists' });
  if (err.code === '23503') return res.status(400).json({ error: 'Invalid reference' });
  res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message });
});

// ── START ─────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 3000;
app.listen(PORT, () => {
  logger.info(`🚀 Wapify API running on port ${PORT} [${process.env.NODE_ENV}]`);
  logger.info(`📊 Admin API at /api/admin`);
});

module.exports = app;
