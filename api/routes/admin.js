// routes/admin.js — CEO Admin Panel API
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../config/db');
const { authenticateAdmin } = require('../middleware/auth');

// Admin login — no auth middleware
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const r = await query('SELECT * FROM admin_users WHERE email=$1 AND is_active=true', [email]);
  if (!r.rows.length) return res.status(401).json({ error: 'Invalid credentials' });
  if (!await bcrypt.compare(password, r.rows[0].password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
  await query('UPDATE admin_users SET last_login_at=NOW() WHERE id=$1', [r.rows[0].id]);
  const token = jwt.sign({ adminId: r.rows[0].id, role: r.rows[0].role }, process.env.ADMIN_JWT_SECRET, { expiresIn: '8h' });
  const { password_hash, ...admin } = r.rows[0];
  res.json({ token, admin });
});

router.use(authenticateAdmin);

// Overview
router.get('/overview', async (req, res) => {
  const [orgs, revenue, msgs] = await Promise.all([
    query(`SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE plan='growth')::int AS growth,
      COUNT(*) FILTER (WHERE plan='scale')::int AS scale,
      COUNT(*) FILTER (WHERE plan='agency')::int AS agency,
      COUNT(*) FILTER (WHERE plan_status='trial')::int AS trial,
      COUNT(*) FILTER (WHERE plan_status='cancelled')::int AS cancelled,
      COUNT(*) FILTER (WHERE plan_status='active')::int AS active
      FROM organizations`),
    query(`SELECT COALESCE(SUM(CASE WHEN plan='growth' THEN 29 WHEN plan='scale' THEN 79 WHEN plan='agency' THEN 199 ELSE 0 END),0) AS mrr
      FROM organizations WHERE plan_status='active'`),
    query(`SELECT COUNT(*)::int AS total FROM messages WHERE created_at>NOW()-INTERVAL '30 days'`),
  ]);
  res.json({ orgs: orgs.rows[0], mrr: revenue.rows[0].mrr, messages_30d: msgs.rows[0].total });
});

// All customers (orgs)
router.get('/customers', async (req, res) => {
  const { page=1, limit=25, plan, status, search } = req.query;
  const offset = (page-1)*limit;
  const params = [];
  let where = 'WHERE 1=1';
  let i = 1;
  if (plan)   { where += ` AND o.plan=$${i++}`;        params.push(plan); }
  if (status) { where += ` AND o.plan_status=$${i++}`; params.push(status); }
  if (search) { where += ` AND (o.name ILIKE $${i} OR u.email ILIKE $${i})`; params.push(`%${search}%`); i++; }
  const [rows, count] = await Promise.all([
    query(`SELECT o.id,o.name,o.slug,o.plan,o.plan_status,o.msg_quota,o.msg_used,o.created_at,o.billing_email,o.country,o.stripe_customer_id,
      u.email AS owner_email,u.first_name,u.last_name,
      (SELECT COUNT(*)::int FROM stores WHERE org_id=o.id AND status!='disconnected') AS store_count,
      (SELECT COUNT(*)::int FROM users WHERE org_id=o.id AND is_active=true) AS member_count
      FROM organizations o LEFT JOIN users u ON u.org_id=o.id AND u.is_owner=true
      ${where} ORDER BY o.created_at DESC LIMIT $${i} OFFSET $${i+1}`, [...params, limit, offset]),
    query(`SELECT COUNT(*) FROM organizations o LEFT JOIN users u ON u.org_id=o.id AND u.is_owner=true ${where}`, params),
  ]);
  res.json({ customers: rows.rows, total: parseInt(count.rows[0].count) });
});

// Single customer detail
router.get('/customers/:id', async (req, res) => {
  const [org, members, stores] = await Promise.all([
    query('SELECT * FROM organizations WHERE id=$1', [req.params.id]),
    query(`SELECT u.id,u.email,u.first_name,u.last_name,u.is_owner,u.last_login_at,u.is_active,r.name AS role_name
      FROM users u LEFT JOIN roles r ON r.id=u.role_id WHERE u.org_id=$1`, [req.params.id]),
    query('SELECT id,name,platform,status,last_sync_at,sync_error FROM stores WHERE org_id=$1', [req.params.id]),
  ]);
  if (!org.rows.length) return res.status(404).json({ error: 'Not found' });
  res.json({ org: org.rows[0], members: members.rows, stores: stores.rows });
});

// Update customer plan
router.put('/customers/:id', async (req, res) => {
  const { plan, plan_status, msg_quota, max_stores } = req.body;
  const r = await query(`UPDATE organizations SET plan=COALESCE($1,plan),plan_status=COALESCE($2,plan_status),
    msg_quota=COALESCE($3,msg_quota),max_stores=COALESCE($4,max_stores),updated_at=NOW()
    WHERE id=$5 RETURNING *`, [plan, plan_status, msg_quota, max_stores, req.params.id]);
  res.json({ org: r.rows[0] });
});

// Revenue stats
router.get('/revenue', async (req, res) => {
  const r = await query(`SELECT DATE_TRUNC('month',created_at) AS month,
    SUM(CASE WHEN plan='growth' THEN 29 WHEN plan='scale' THEN 79 WHEN plan='agency' THEN 199 ELSE 0 END) AS mrr,
    COUNT(*) FILTER (WHERE plan_status='active')::int AS active_count,
    COUNT(*) FILTER (WHERE plan_status='cancelled')::int AS churned
    FROM organizations WHERE plan_status IN ('active','cancelled')
    GROUP BY 1 ORDER BY 1 DESC LIMIT 12`);
  res.json({ revenue: r.rows });
});

// Feature flags
router.get('/feature-flags', async (req, res) => {
  const r = await query('SELECT * FROM feature_flags ORDER BY key');
  res.json({ flags: r.rows });
});

router.put('/feature-flags/:key', async (req, res) => {
  const { enabled, plans } = req.body;
  const r = await query(`UPDATE feature_flags SET enabled=COALESCE($1,enabled),
    plans=COALESCE($2::text[],plans),updated_at=NOW() WHERE key=$3 RETURNING *`,
    [enabled, plans, req.params.key]);
  if (!r.rows.length) return res.status(404).json({ error: 'Flag not found' });
  res.json({ flag: r.rows[0] });
});

// Announcements
router.get('/announcements', async (req, res) => {
  const r = await query('SELECT * FROM announcements ORDER BY created_at DESC');
  res.json({ announcements: r.rows });
});

router.post('/announcements', async (req, res) => {
  const { title, message, type, audience, plan_filter, ends_at } = req.body;
  if (!title || !message) return res.status(400).json({ error: 'Title and message required' });
  const r = await query(`INSERT INTO announcements (title,message,type,audience,plan_filter,ends_at,status,created_by)
    VALUES ($1,$2,$3,$4,$5,$6,'active',$7) RETURNING *`,
    [title, message, type||'info', audience||'all', plan_filter, ends_at, req.admin.id]);
  res.status(201).json({ announcement: r.rows[0] });
});

router.put('/announcements/:id', async (req, res) => {
  const { status, title, message } = req.body;
  const r = await query('UPDATE announcements SET status=COALESCE($1,status),title=COALESCE($2,title),message=COALESCE($3,message) WHERE id=$4 RETURNING *',
    [status, title, message, req.params.id]);
  res.json({ announcement: r.rows[0] });
});

// All stores
router.get('/stores', async (req, res) => {
  const { page=1, limit=25, platform, status } = req.query;
  const offset = (page-1)*limit;
  const params = [];
  let where = 'WHERE 1=1';
  let i = 1;
  if (platform) { where += ` AND s.platform=$${i++}`; params.push(platform); }
  if (status)   { where += ` AND s.status=$${i++}`;   params.push(status); }
  const r = await query(`SELECT s.*,o.name AS org_name FROM stores s JOIN organizations o ON o.id=s.org_id
    ${where} ORDER BY s.created_at DESC LIMIT $${i} OFFSET $${i+1}`, [...params, limit, offset]);
  res.json({ stores: r.rows });
});

// Message usage
router.get('/messages', async (req, res) => {
  const r = await query(`SELECT o.id,o.name,o.plan,o.msg_quota,o.msg_used,
    ROUND(o.msg_used::numeric/NULLIF(o.msg_quota,0)*100,1) AS usage_pct
    FROM organizations o WHERE o.plan_status='active'
    ORDER BY usage_pct DESC LIMIT 50`);
  res.json({ usage: r.rows });
});

// Audit log
router.get('/audit', async (req, res) => {
  const { page=1, limit=50 } = req.query;
  const offset = (page-1)*limit;
  const r = await query(`SELECT al.*,u.email AS user_email FROM audit_logs al
    LEFT JOIN users u ON u.id=al.user_id
    ORDER BY al.created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]);
  res.json({ logs: r.rows });
});

// Admin team
router.get('/team', async (req, res) => {
  if (req.admin.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  const r = await query('SELECT id,email,name,role,is_active,last_login_at,created_at FROM admin_users ORDER BY created_at');
  res.json({ admins: r.rows });
});

router.post('/team', async (req, res) => {
  if (req.admin.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  const { email, name, role, password } = req.body;
  if (!email || !password || !role) return res.status(400).json({ error: 'All fields required' });
  const hash = await bcrypt.hash(password, 12);
  const r = await query('INSERT INTO admin_users (email,password_hash,name,role) VALUES ($1,$2,$3,$4) RETURNING id,email,name,role',
    [email, hash, name, role]);
  res.status(201).json({ admin: r.rows[0] });
});

module.exports = router;
