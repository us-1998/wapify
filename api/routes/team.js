// routes/team.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const email = require('../services/email');
router.use(authenticate);

router.get('/', requirePermission('team:view'), async (req, res) => {
  const r = await query(`SELECT u.id,u.email,u.first_name,u.last_name,u.avatar_url,u.is_owner,u.is_active,
    u.last_login_at,u.created_at,r.id AS role_id,r.name AS role_name,r.slug AS role_slug
    FROM users u LEFT JOIN roles r ON r.id=u.role_id
    WHERE u.org_id=$1 ORDER BY u.is_owner DESC,u.created_at ASC`, [req.user.org_id]);
  res.json({ members: r.rows });
});

router.get('/roles', requirePermission('team:view'), async (req, res) => {
  const r = await query(`SELECT id,name,slug,description,is_system,permissions,
    (SELECT COUNT(*) FROM users WHERE role_id=roles.id AND is_active=true)::int AS member_count
    FROM roles WHERE org_id=$1 ORDER BY is_system DESC,name ASC`, [req.user.org_id]);
  res.json({ roles: r.rows });
});

router.post('/roles', requirePermission('team:edit'), async (req, res) => {
  const { name, description, permissions } = req.body;
  if (!name || !permissions) return res.status(400).json({ error: 'Name and permissions required' });
  const slug = name.toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,'');
  const r = await query(`INSERT INTO roles (org_id,name,slug,description,is_system,permissions)
    VALUES ($1,$2,$3,$4,false,$5::jsonb) RETURNING *`,
    [req.user.org_id, name, slug, description, JSON.stringify(permissions)]);
  res.status(201).json({ role: r.rows[0] });
});

router.put('/roles/:id', requirePermission('team:edit'), async (req, res) => {
  const { name, description, permissions } = req.body;
  const check = await query('SELECT slug FROM roles WHERE id=$1 AND org_id=$2', [req.params.id, req.user.org_id]);
  if (!check.rows.length) return res.status(404).json({ error: 'Role not found' });
  if (check.rows[0].slug === 'owner') return res.status(403).json({ error: 'Cannot edit owner role' });
  const r = await query(`UPDATE roles SET name=COALESCE($1,name),description=COALESCE($2,description),
    permissions=COALESCE($3::jsonb,permissions) WHERE id=$4 AND org_id=$5 RETURNING *`,
    [name, description, permissions?JSON.stringify(permissions):null, req.params.id, req.user.org_id]);
  res.json({ role: r.rows[0] });
});

router.post('/invite', requirePermission('team:invite'), async (req, res) => {
  const { email: em, role_id, first_name, last_name } = req.body;
  if (!em || !role_id) return res.status(400).json({ error: 'Email and role required' });
  const roleCheck = await query('SELECT * FROM roles WHERE id=$1 AND org_id=$2', [role_id, req.user.org_id]);
  if (!roleCheck.rows.length) return res.status(400).json({ error: 'Invalid role' });
  if (roleCheck.rows[0].slug === 'owner') return res.status(403).json({ error: 'Cannot invite someone as owner' });
  const exists = await query('SELECT id FROM users WHERE email=$1', [em.toLowerCase()]);
  if (exists.rows.length) return res.status(409).json({ error: 'This email is already registered' });
  const tempPw = uuidv4().replace(/-/g,'').slice(0,10) + 'A1!';
  const hash = await bcrypt.hash(tempPw, 12);
  const r = await query(`INSERT INTO users (org_id,role_id,email,password_hash,first_name,last_name,is_email_verified)
    VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING id,email,first_name,last_name`,
    [req.user.org_id, role_id, em.toLowerCase(), hash, first_name||'', last_name||'']);
  await email.sendInvite({ to: em, inviterName: `${req.user.first_name} ${req.user.last_name}`, orgName: req.user.org_name,
    roleName: roleCheck.rows[0].name, tempPassword: tempPw, loginUrl: `${process.env.APP_URL}/` }).catch(()=>{});
  await query(`INSERT INTO audit_logs (org_id,user_id,action,resource,resource_id,details) VALUES ($1,$2,'team.invite','user',$3,$4)`,
    [req.user.org_id, req.user.id, r.rows[0].id, JSON.stringify({ email: em, role: roleCheck.rows[0].name })]);
  res.status(201).json({ member: r.rows[0], message: 'Invitation sent to ' + em });
});

router.put('/members/:id', requirePermission('team:edit'), async (req, res) => {
  const { role_id } = req.body;
  if (!role_id) return res.status(400).json({ error: 'role_id required' });
  const target = await query('SELECT * FROM users WHERE id=$1 AND org_id=$2', [req.params.id, req.user.org_id]);
  if (!target.rows.length) return res.status(404).json({ error: 'Member not found' });
  if (target.rows[0].is_owner) return res.status(403).json({ error: 'Cannot change owner role' });
  const roleCheck = await query('SELECT * FROM roles WHERE id=$1 AND org_id=$2', [role_id, req.user.org_id]);
  if (!roleCheck.rows.length) return res.status(400).json({ error: 'Invalid role' });
  if (roleCheck.rows[0].slug === 'owner') return res.status(403).json({ error: 'Cannot assign owner role' });
  await query('UPDATE users SET role_id=$1,updated_at=NOW() WHERE id=$2', [role_id, req.params.id]);
  res.json({ message: 'Role updated' });
});

router.delete('/members/:id', requirePermission('team:remove'), async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot remove yourself' });
  const target = await query('SELECT * FROM users WHERE id=$1 AND org_id=$2', [req.params.id, req.user.org_id]);
  if (!target.rows.length) return res.status(404).json({ error: 'Member not found' });
  if (target.rows[0].is_owner) return res.status(403).json({ error: 'Cannot remove the owner' });
  await query('UPDATE users SET is_active=false,updated_at=NOW() WHERE id=$1', [req.params.id]);
  await query('UPDATE refresh_tokens SET revoked=true WHERE user_id=$1', [req.params.id]);
  await query(`INSERT INTO audit_logs (org_id,user_id,action,resource,resource_id,details) VALUES ($1,$2,'team.remove','user',$3,$4)`,
    [req.user.org_id, req.user.id, req.params.id, JSON.stringify({ email: target.rows[0].email })]);
  res.json({ message: 'Member removed' });
});

router.put('/members/:id/toggle', requirePermission('team:edit'), async (req, res) => {
  const target = await query('SELECT is_active,is_owner FROM users WHERE id=$1 AND org_id=$2', [req.params.id, req.user.org_id]);
  if (!target.rows.length) return res.status(404).json({ error: 'Member not found' });
  if (target.rows[0].is_owner) return res.status(403).json({ error: 'Cannot suspend the owner' });
  const newStatus = !target.rows[0].is_active;
  await query('UPDATE users SET is_active=$1 WHERE id=$2', [newStatus, req.params.id]);
  if (!newStatus) await query('UPDATE refresh_tokens SET revoked=true WHERE user_id=$1', [req.params.id]);
  res.json({ active: newStatus });
});

module.exports = router;
