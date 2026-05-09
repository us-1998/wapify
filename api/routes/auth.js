// routes/auth.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { query, transaction } = require('../config/db');
const { authenticate } = require('../middleware/auth');
const PERMS = require('../config/permissions');
const email = require('../services/email');

const sign = (userId, orgId) => ({
  access: jwt.sign({ userId, orgId }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }),
  refresh: jwt.sign({ userId, orgId }, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d' }),
});

router.post('/signup', async (req, res) => {
  const { email: em, password, first_name, last_name, company_name, phone } = req.body;
  if (!em || !password || !company_name) return res.status(400).json({ error: 'Email, password and company name are required' });
  if (password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password))
    return res.status(400).json({ error: 'Password must be 8+ chars with 1 uppercase and 1 number' });

  const exists = await query('SELECT id FROM users WHERE email=$1', [em.toLowerCase()]);
  if (exists.rows.length) return res.status(409).json({ error: 'Email already registered' });

  const pwHash = await bcrypt.hash(password, 12);
  const verifyToken = uuidv4();
  const slug = company_name.toLowerCase().replace(/[^a-z0-9]/g,'-').replace(/-+/g,'-') + '-' + Date.now().toString(36);

  const result = await transaction(async (client) => {
    const orgR = await client.query(`INSERT INTO organizations (name,slug,plan,plan_status,msg_quota,max_stores,billing_email)
      VALUES ($1,$2,'free','trial',100,1,$3) RETURNING id`, [company_name, slug, em.toLowerCase()]);
    const orgId = orgR.rows[0].id;
    const roleIds = {};
    const rNames = { owner:'Owner', admin:'Admin', marketing:'Marketing', sales:'Sales', support:'Support' };
    const rDescs = { owner:'Full access', admin:'Admin access', marketing:'Marketing access', sales:'Sales access', support:'Support access' };
    for (const [s, perms] of Object.entries(PERMS)) {
      const r = await client.query(`INSERT INTO roles (org_id,name,slug,description,is_system,permissions) VALUES ($1,$2,$3,$4,true,$5::jsonb) RETURNING id`,
        [orgId, rNames[s], s, rDescs[s], JSON.stringify(perms)]);
      roleIds[s] = r.rows[0].id;
    }
    const uR = await client.query(`INSERT INTO users (org_id,role_id,email,password_hash,first_name,last_name,phone,is_owner,email_verify_token)
      VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8) RETURNING id`,
      [orgId, roleIds.owner, em.toLowerCase(), pwHash, first_name, last_name, phone, verifyToken]);
    return { userId: uR.rows[0].id, orgId };
  });

  email.sendVerification(em, verifyToken).catch(()=>{});
  const tokens = sign(result.userId, result.orgId);
  await query(`INSERT INTO refresh_tokens (user_id,token,expires_at) VALUES ($1,$2,NOW()+INTERVAL '7 days')`, [result.userId, tokens.refresh]);
  res.status(201).json({ access_token: tokens.access, refresh_token: tokens.refresh });
});

router.post('/login', async (req, res) => {
  const { email: em, password } = req.body;
  if (!em || !password) return res.status(400).json({ error: 'Email and password required' });
  const result = await query(`
    SELECT u.*,r.slug AS role_slug,r.name AS role_name,r.permissions,
           o.plan,o.plan_status,o.name AS org_name,o.slug AS org_slug,o.msg_quota,o.msg_used
    FROM users u LEFT JOIN roles r ON r.id=u.role_id LEFT JOIN organizations o ON o.id=u.org_id
    WHERE u.email=$1`, [em.toLowerCase()]);
  const user = result.rows[0];
  if (!user || !user.is_active) return res.status(401).json({ error: 'Invalid credentials' });
  if (!await bcrypt.compare(password, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
  await query('UPDATE users SET last_login_at=NOW(),last_login_ip=$1 WHERE id=$2', [req.ip, user.id]);
  const tokens = sign(user.id, user.org_id);
  await query(`INSERT INTO refresh_tokens (user_id,token,expires_at) VALUES ($1,$2,NOW()+INTERVAL '7 days')`, [user.id, tokens.refresh]);
  const { password_hash, ...safe } = user;
  res.json({ access_token: tokens.access, refresh_token: tokens.refresh, user: safe });
});

router.post('/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'Refresh token required' });
  let decoded;
  try { decoded = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET); } catch { return res.status(401).json({ error: 'Invalid token' }); }
  const stored = await query('SELECT * FROM refresh_tokens WHERE token=$1 AND revoked=false AND expires_at>NOW()', [refresh_token]);
  if (!stored.rows.length) return res.status(401).json({ error: 'Token revoked or expired' });
  await query('UPDATE refresh_tokens SET revoked=true WHERE token=$1', [refresh_token]);
  const tokens = sign(decoded.userId, decoded.orgId);
  await query(`INSERT INTO refresh_tokens (user_id,token,expires_at) VALUES ($1,$2,NOW()+INTERVAL '7 days')`, [decoded.userId, tokens.refresh]);
  res.json({ access_token: tokens.access, refresh_token: tokens.refresh });
});

router.post('/logout', authenticate, async (req, res) => {
  const { refresh_token } = req.body;
  if (refresh_token) await query('UPDATE refresh_tokens SET revoked=true WHERE token=$1', [refresh_token]);
  res.json({ message: 'Logged out' });
});

router.get('/me', authenticate, async (req, res) => {
  const { password_hash, ...safe } = req.user;
  res.json({ user: safe });
});

router.put('/profile', authenticate, async (req, res) => {
  const { first_name, last_name, preferences, password } = req.body;
  if (password) {
    if (password.length < 8) return res.status(400).json({ error: 'Password must be 8+ chars' });
    const hash = await bcrypt.hash(password, 12);
    await query('UPDATE users SET password_hash=$1,updated_at=NOW() WHERE id=$2', [hash, req.user.id]);
  }
  const r = await query(`UPDATE users SET first_name=COALESCE($1,first_name),last_name=COALESCE($2,last_name),
    preferences=COALESCE($3::jsonb,preferences),updated_at=NOW() WHERE id=$4 RETURNING *`,
    [first_name, last_name, preferences ? JSON.stringify(preferences) : null, req.user.id]);
  const { password_hash, ...safe } = r.rows[0];
  res.json({ user: safe });
});

router.post('/forgot-password', async (req, res) => {
  const { email: em } = req.body;
  const user = await query('SELECT id,email,first_name FROM users WHERE email=$1', [em?.toLowerCase()]);
  if (user.rows.length) {
    const token = uuidv4();
    await query('UPDATE users SET password_reset_token=$1,password_reset_expires=NOW()+INTERVAL\'1 hour\' WHERE id=$2', [token, user.rows[0].id]);
    await email.sendPasswordReset(em, token).catch(()=>{});
  }
  res.json({ message: 'If that email exists, a reset link has been sent.' });
});

router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password || password.length < 8) return res.status(400).json({ error: 'Invalid request' });
  const user = await query('SELECT id FROM users WHERE password_reset_token=$1 AND password_reset_expires>NOW()', [token]);
  if (!user.rows.length) return res.status(400).json({ error: 'Invalid or expired reset token' });
  const hash = await bcrypt.hash(password, 12);
  await query('UPDATE users SET password_hash=$1,password_reset_token=NULL,password_reset_expires=NULL WHERE id=$2', [hash, user.rows[0].id]);
  await query('UPDATE refresh_tokens SET revoked=true WHERE user_id=$1', [user.rows[0].id]);
  res.json({ message: 'Password reset successfully' });
});

module.exports = router;
