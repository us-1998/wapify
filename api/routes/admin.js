// routes/admin.js — CEO Admin Panel API
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../config/db');
const { authenticateAdmin, requireAdminRole } = require('../middleware/auth');

// ── Admin Login ───────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const result = await query('SELECT * FROM admin_users WHERE email=$1 AND is_active=true', [email]);
  if (!result.rows.length) return res.status(401).json({ error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, result.rows[0].password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  await query('UPDATE admin_users SET last_login_at=NOW() WHERE id=$1', [result.rows[0].id]);
  const token = jwt.sign({ adminId: result.rows[0].id, role: result.rows[0].role }, process.env.ADMIN_JWT_SECRET, { expiresIn: '8h' });
  const { password_hash, ...admin } = result.rows[0];
  res.json({ token, admin });
});

router.use(authenticateAdmin);

// ── OVERVIEW ─────────────────────────────────────────────────
router.get('/overview', async (req, res) => {
  const [orgs, revenue, msgs, churn] = await Promise.all([
    query(`SELECT COUNT(*) AS total,
      COUNT(*) FILTER (WHERE plan='growth') AS growth,
      COUNT(*) FILTER (WHERE plan='scale') AS scale,
      COUNT(*) FILTER (WHERE plan='agency') AS agency,
      COUNT(*) FILTER (WHERE plan_status='trial') AS trial,
      COUNT(*) FILTER (WHERE plan_status='cancelled') AS cancelled
      FROM organizations`),
    query(`SELECT
      SUM(CASE WHEN plan='growth' THEN 29 WHEN plan='scale' THEN 79 WHEN plan='agency' THEN 199 ELSE 0 END) AS mrr
      FROM organizations WHERE plan_status='active'`),
    query(`SELECT COUNT(*) AS total FROM messages WHERE created_at > NOW()-INTERVAL '30 days'`),
    query(`SELECT ROUND(COUNT(*) FILTER (WHERE plan_status='cancelled')::numeric / NULLIF(COUNT(*),0)*100,1) AS rate
           FROM organizations WHERE created_at > NOW()-INTERVAL '30 days'`),
  ]);
  res.json({
    orgs: orgs.rows[0],
    mrr: revenue.rows[0].mrr || 0,
    messages_30d: msgs.rows[0].total,
    churn_rate: churn.rows[0].rate || 0,
  });
});

// ── CUSTOMERS ─────────────────────────────────────────────────
router.get('/customers', async (req, res) => {
  const { page = 1, limit = 25, plan, status, search } = req.query;
  const offset = (page - 1) * limit;
  const params = [];
  let where = 'WHERE 1=1';
  let i = 1;
  if (plan)   { where += ` AND o.plan=$${i++}`;         params.push(plan); }
  if (status) { where += ` AND o.plan_status=$${i++}`;  params.push(status); }
  if (search) { where += ` AND (o.name ILIKE $${i} OR u.email ILIKE $${i})`; params.push(`%${search}%`); i++; }

  const [rows, count] = await Promise.all([
    query(`SELECT o.id, o.name, o.slug, o.plan, o.plan_status, o.msg_quota, o.msg_used,
                  o.created_at, o.stripe_customer_id, o.country,
                  u.email AS owner_email, u.first_name, u.last_name,
                  (SELECT COUNT(*) FROM stores WHERE org_id=o.id) AS store_count,
                  (SELECT COUNT(*) FROM users WHERE org_id=o.id) AS member_count
           FROM organizations o
           LEFT JOIN users u ON u.org_id=o.id AND u.is_owner=true
           ${where} ORDER BY o.created_at DESC LIMIT $${i} OFFSET $${i+1}`,
      [...params, limit, offset]),
    query(`SELECT COUNT(*) FROM organizations o LEFT JOIN users u ON u.org_id=o.id AND u.is_owner=true ${where}`, params),
  ]);
  res.json({ customers: rows.rows, total: parseInt(count.rows[0].count) });
});

router.get('/customers/:id', async (req, res) => {
  const [org, members, stores] = await Promise.all([
    query('SELECT * FROM organizations WHERE id=$1', [req.params.id]),
    query(`SELECT u.id, u.email, u.first_name, u.last_name, u.is_owner, u.last_login_at, r.name AS role_name
           FROM users u LEFT JOIN roles r ON r.id=u.role_id WHERE u.org_id=$1`, [req.params.id]),
    query('SELECT id, name, platform, status FROM stores WHERE org_id=$1', [req.params.id]),
  ]);
  if (!org.rows.length) return res.status(404).json({ error: 'Not found' });
  res.json({ org: org.rows[0], members: members.rows, stores: stores.rows });
});

router.put('/customers/:id', requireAdminRole('admin','billing'), async (req, res) => {
  const { plan, plan_status, msg_quota, max_stores } = req.body;
  const result = await query(`UPDATE organizations SET plan=COALESCE($1,plan), plan_status=COALESCE($2,plan_status),
    msg_quota=COALESCE($3,msg_quota), max_stores=COALESCE($4,max_stores) WHERE id=$5 RETURNING *`,
    [plan, plan_status, msg_quota, max_stores, req.params.id]);
  res.json({ org: result.rows[0] });
});

// ── STORES ADMIN ──────────────────────────────────────────────
router.get('/stores', async (req, res) => {
  const { page = 1, limit = 25, platform, status } = req.query;
  const offset = (page - 1) * limit;
  const params = [];
  let where = 'WHERE 1=1';
  let i = 1;
  if (platform) { where += ` AND s.platform=$${i++}`; params.push(platform); }
  if (status)   { where += ` AND s.status=$${i++}`;   params.push(status); }

  const result = await query(`SELECT s.*, o.name AS org_name FROM stores s
    JOIN organizations o ON o.id=s.org_id
    ${where} ORDER BY s.created_at DESC LIMIT $${i} OFFSET $${i+1}`,
    [...params, limit, offset]);
  res.json({ stores: result.rows });
});

// ── REVENUE ───────────────────────────────────────────────────
router.get('/revenue', async (req, res) => {
  const result = await query(`SELECT
    DATE_TRUNC('month', created_at) AS month,
    SUM(CASE WHEN plan='growth' THEN 29 WHEN plan='scale' THEN 79 WHEN plan='agency' THEN 199 ELSE 0 END) AS mrr,
    COUNT(*) FILTER (WHERE plan_status='active') AS active_count
    FROM organizations WHERE plan_status IN ('active','cancelled')
    GROUP BY 1 ORDER BY 1 DESC LIMIT 12`);
  res.json({ revenue: result.rows });
});

// ── FEATURE FLAGS ─────────────────────────────────────────────
router.get('/feature-flags', async (req, res) => {
  const result = await query('SELECT * FROM feature_flags ORDER BY key');
  res.json({ flags: result.rows });
});

router.put('/feature-flags/:key', requireAdminRole('admin'), async (req, res) => {
  const { enabled, plans } = req.body;
  const result = await query(`UPDATE feature_flags SET enabled=COALESCE($1,enabled),
    plans=COALESCE($2::text[],plans), updated_at=NOW() WHERE key=$3 RETURNING *`,
    [enabled, plans, req.params.key]);
  res.json({ flag: result.rows[0] });
});

// ── ANNOUNCEMENTS ─────────────────────────────────────────────
router.get('/announcements', async (req, res) => {
  const result = await query('SELECT * FROM announcements ORDER BY created_at DESC');
  res.json({ announcements: result.rows });
});

router.post('/announcements', requireAdminRole('admin','marketing'), async (req, res) => {
  const { title, message, type, audience, plan_filter, ends_at } = req.body;
  const result = await query(`INSERT INTO announcements (title,message,type,audience,plan_filter,ends_at,status,created_by)
    VALUES ($1,$2,$3,$4,$5,$6,'active',$7) RETURNING *`,
    [title, message, type, audience, plan_filter, ends_at, req.admin.id]);
  res.status(201).json({ announcement: result.rows[0] });
});

// ── ADMIN TEAM ────────────────────────────────────────────────
router.get('/team', requireAdminRole('owner'), async (req, res) => {
  const result = await query('SELECT id, email, name, role, is_active, last_login_at, created_at FROM admin_users ORDER BY created_at');
  res.json({ admins: result.rows });
});

router.post('/team', requireAdminRole('owner'), async (req, res) => {
  const { email, name, role, password } = req.body;
  if (!email || !password || !role) return res.status(400).json({ error: 'All fields required' });
  const hash = await bcrypt.hash(password, 12);
  const result = await query(`INSERT INTO admin_users (email,password_hash,name,role) VALUES ($1,$2,$3,$4) RETURNING id,email,name,role`,
    [email, hash, name, role]);
  res.status(201).json({ admin: result.rows[0] });
});

// ── AUDIT LOG ─────────────────────────────────────────────────
router.get('/audit', async (req, res) => {
  const { page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;
  const result = await query(`SELECT al.*, u.email AS user_email
    FROM audit_logs al LEFT JOIN users u ON u.id=al.user_id
    ORDER BY al.created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]);
  res.json({ logs: result.rows });
});

module.exports = router;
