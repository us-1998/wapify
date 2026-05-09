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

const app = express();

// Security
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: [process.env.APP_URL, process.env.ADMIN_URL, 'http://localhost:3000', 'http://localhost:5000'],
  credentials: true,
  methods: ['GET','POST','PUT','DELETE','PATCH','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
app.set('trust proxy', 1);

// Rate limiting
app.use('/api/', rateLimit({ windowMs: 900000, max: parseInt(process.env.RATE_LIMIT_MAX)||200, message: { error: 'Too many requests' } }));
app.use('/api/auth/login', rateLimit({ windowMs: 900000, max: 10, message: { error: 'Too many login attempts' } }));
app.use('/api/admin/login', rateLimit({ windowMs: 900000, max: 10, message: { error: 'Too many login attempts' } }));

// Raw body for webhooks — MUST be before express.json()
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));
app.use('/api/whatsapp/webhook', express.raw({ type: 'application/json' }));
app.use('/api/stores/webhooks', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(compression());
app.use(morgan('combined'));

// API Routes
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/stores',        require('./routes/stores'));
app.use('/api/orders',        require('./routes/orders'));
app.use('/api/conversations', require('./routes/conversations'));
app.use('/api/flows',         require('./routes/flows'));
app.use('/api/templates',     require('./routes/templates'));
app.use('/api/products',      require('./routes/products'));
app.use('/api/broadcasts',    require('./routes/broadcasts'));
app.use('/api/analytics',     require('./routes/analytics'));
app.use('/api/billing',       require('./routes/billing'));
app.use('/api/team',          require('./routes/team'));
app.use('/api/whatsapp',      require('./routes/whatsapp'));
app.use('/api/admin',         require('./routes/admin'));

// Health check
app.get('/health', async (req, res) => {
  const { pool } = require('./config/db');
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0', env: process.env.NODE_ENV });
  } catch {
    res.status(503).json({ status: 'error', message: 'Database unavailable' });
  }
});

// ── SERVE FRONTEND ──────────────────────────────────────────
// Serve the static files from the 'public' directory at the root
app.use(express.static(path.join(__dirname, '../public')));

// Handle Single Page Application (SPA) routing for all non-API/health routes
app.get(/^(?!\/api|\/health).*/, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (err.code === '23505') return res.status(409).json({ error: 'Already exists' });
  if (err.code === '23503') return res.status(400).json({ error: 'Invalid reference' });
  if (err.name === 'ValidationError') return res.status(400).json({ error: err.message });
  res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message });
});

const PORT = parseInt(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Wapify API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
});

module.exports = app;
