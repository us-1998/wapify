// routes/auth.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { query, transaction } = require('../config/db');
const { authenticate } = require('../middleware/auth');
const emailService = require('../services/email');

const PERMISSIONS = require('../config/permissions');

// Helper: generate tokens
const signTokens = (userId, orgId) => {
  const access = jwt.sign({ userId, orgId }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '15m' });
  const refresh = jwt.sign({ userId, orgId }, process.env.JWT_REFRESH_SECRET, { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' });
  return { access, refresh };
};

// ── POST /auth/signup ─────────────────────────────────────────
router.post('/signup', async (req, res) => {
  const { email, password, first_name, last_name, company_name, phone } = req.body;

  if (!email || !password || !company_name) {
    return res.status(400).json({ error: 'Email, password and company name are required' });
  }
  if (password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    return res.status(400).json({ error: 'Password must be 8+ chars with 1 uppercase and 1 number' });
  }

  const existing = await query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
  if (existing.rows.length) return res.status(409).json({ error: 'Email already registered' });

  const passwordHash = await bcrypt.hash(password, 12);
  const verifyToken = uuidv4();
  const orgSlug = company_name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-') + '-' + Date.now().toString(36);

  const result = await transaction(async (client) => {
    // Create org
    const orgRes = await client.query(`
      INSERT INTO organizations (name, slug, plan, plan_status, msg_quota, max_stores, billing_email)
      VALUES ($1,$2,'free','trial',100,1,$3)
      RETURNING id
    `, [company_name, orgSlug, email.toLowerCase()]);
    const orgId = orgRes.rows[0].id;

    // Create all 5 system roles for this org
    const roleIds = {};
    for (const [slug, perms] of Object.entries(PERMISSIONS)) {
      const rMeta = { owner:'Owner', admin:'Admin', marketing:'Marketing', sales:'Sales', support:'Support' };
      const rDesc = { owner:'Full access', admin:'Admin access', marketing:'Marketing access', sales:'Sales access', support:'Support access' };
      const rRes = await client.query(`
        INSERT INTO roles (org_id, name, slug, description, is_system, permissions)
        VALUES ($1,$2,$3,$4,true,$5) RETURNING id
      `, [orgId, rMeta[slug], slug, rDesc[slug], JSON.stringify(perms)]);
      roleIds[slug] = rRes.rows[0].id;
    }

    // Create owner user
    const userRes = await client.query(`
      INSERT INTO users (org_id, role_id, email, password_hash, first_name, last_name, phone, is_owner, email_verify_token)
      VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8) RETURNING id
    `, [orgId, roleIds.owner, email.toLowerCase(), passwordHash, first_name, last_name, phone, verifyToken]);
    const userId = userRes.rows[0].id;

    return { userId, orgId };
  });

  // Send verification email (non-blocking)
  emailService.sendVerification(email, verifyToken).catch(() => {});

  const { access, refresh } = signTokens(result.userId, result.orgId);
  await query(`INSERT INTO refresh_tokens (user_id, token, expires_at, ip_address)
    VALUES ($1,$2,NOW()+INTERVAL '7 days',$3)`,
    [result.userId, refresh, req.ip]);

  res.status(201).json({ access_token: access, refresh_token: refresh, message: 'Account created. Check email to verify.' });
});

// ── POST /auth/login ──────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const result = await query(`
    SELECT u.id, u.email, u.password_hash, u.is_active, u.is_owner, u.org_id,
           u.first_name, u.last_name, u.avatar_url,
           r.slug AS role_slug, r.name AS role_name, r.permissions,
           o.plan, o.plan_status, o.name AS org_name, o.slug AS org_slug
    FROM users u
    LEFT JOIN roles r ON r.id = u.role_id
    LEFT JOIN organizations o ON o.id = u.org_id
    WHERE u.email = $1
  `, [email.toLowerCase()]);

  const user = result.rows[0];
  if (!user || !user.is_active) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  // Update last login
  await query('UPDATE users SET last_login_at=NOW(), last_login_ip=$1 WHERE id=$2', [req.ip, user.id]);

  const { access, refresh } = signTokens(user.id, user.org_id);
  await query(`INSERT INTO refresh_tokens (user_id, token, expires_at, ip_address)
    VALUES ($1,$2,NOW()+INTERVAL '7 days',$3)`,
    [user.id, refresh, req.ip]);

  const { password_hash, ...safeUser } = user;
  res.json({ access_token: access, refresh_token: refresh, user: safeUser });
});

// ── POST /auth/refresh ────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'Refresh token required' });

  let decoded;
  try { decoded = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET); }
  catch { return res.status(401).json({ error: 'Invalid refresh token' }); }

  const stored = await query(
    'SELECT * FROM refresh_tokens WHERE token=$1 AND revoked=false AND expires_at > NOW()',
    [refresh_token]
  );
  if (!stored.rows.length) return res.status(401).json({ error: 'Token revoked or expired' });

  // Rotate: revoke old, issue new
  await query('UPDATE refresh_tokens SET revoked=true WHERE token=$1', [refresh_token]);
  const { access, refresh: newRefresh } = signTokens(decoded.userId, decoded.orgId);
  await query(`INSERT INTO refresh_tokens (user_id, token, expires_at, ip_address)
    VALUES ($1,$2,NOW()+INTERVAL '7 days',$3)`,
    [decoded.userId, newRefresh, req.ip]);

  res.json({ access_token: access, refresh_token: newRefresh });
});

// ── POST /auth/logout ─────────────────────────────────────────
router.post('/logout', authenticate, async (req, res) => {
  const { refresh_token } = req.body;
  if (refresh_token) {
    await query('UPDATE refresh_tokens SET revoked=true WHERE token=$1', [refresh_token]);
  }
  res.json({ message: 'Logged out' });
});

// ── GET /auth/me ──────────────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  const { password_hash, ...safeUser } = req.user;
  res.json({ user: safeUser });
});

// ── GET /auth/verify-email/:token ────────────────────────────
router.get('/verify-email/:token', async (req, res) => {
  const result = await query(
    'UPDATE users SET is_email_verified=true, email_verify_token=null WHERE email_verify_token=$1 RETURNING id',
    [req.params.token]
  );
  if (!result.rows.length) return res.status(400).json({ error: 'Invalid or expired verification link' });
  res.json({ message: 'Email verified successfully' });
});

module.exports = router;
