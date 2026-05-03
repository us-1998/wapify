// routes/team.js — Invite, manage, and remove team members with RBAC
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { query, transaction } = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const emailService = require('../services/email');
const PERMISSIONS = require('../config/permissions');

// All team routes require auth
router.use(authenticate);

// ── GET /team — List all team members ────────────────────────
router.get('/', requirePermission('team:view'), async (req, res) => {
  const result = await query(`
    SELECT u.id, u.email, u.first_name, u.last_name, u.avatar_url,
           u.is_owner, u.is_active, u.last_login_at, u.created_at,
           r.id AS role_id, r.name AS role_name, r.slug AS role_slug
    FROM users u
    LEFT JOIN roles r ON r.id = u.role_id
    WHERE u.org_id = $1
    ORDER BY u.is_owner DESC, u.created_at ASC
  `, [req.user.org_id]);
  res.json({ members: result.rows });
});

// ── GET /team/roles — List all roles for this org ────────────
router.get('/roles', requirePermission('team:view'), async (req, res) => {
  const result = await query(`
    SELECT id, name, slug, description, is_system, permissions,
           (SELECT COUNT(*) FROM users WHERE role_id = roles.id) AS member_count
    FROM roles WHERE org_id = $1 ORDER BY is_system DESC, name ASC
  `, [req.user.org_id]);
  res.json({ roles: result.rows });
});

// ── POST /team/roles — Create custom role ─────────────────────
router.post('/roles', requirePermission('team:edit'), async (req, res) => {
  const { name, description, permissions } = req.body;
  if (!name || !permissions) return res.status(400).json({ error: 'Name and permissions required' });
  const slug = name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');

  const result = await query(`
    INSERT INTO roles (org_id, name, slug, description, is_system, permissions)
    VALUES ($1,$2,$3,$4,false,$5) RETURNING *
  `, [req.user.org_id, name, slug, description, JSON.stringify(permissions)]);
  res.status(201).json({ role: result.rows[0] });
});

// ── PUT /team/roles/:id — Update role permissions ─────────────
router.put('/roles/:id', requirePermission('team:edit'), async (req, res) => {
  const { name, description, permissions } = req.body;

  // Cannot edit owner role
  const roleCheck = await query('SELECT slug FROM roles WHERE id=$1 AND org_id=$2', [req.params.id, req.user.org_id]);
  if (!roleCheck.rows.length) return res.status(404).json({ error: 'Role not found' });
  if (roleCheck.rows[0].slug === 'owner') return res.status(403).json({ error: 'Cannot edit owner role' });

  const result = await query(`
    UPDATE roles SET name=COALESCE($1,name), description=COALESCE($2,description),
    permissions=COALESCE($3::jsonb,permissions)
    WHERE id=$4 AND org_id=$5 RETURNING *
  `, [name, description, permissions ? JSON.stringify(permissions) : null, req.params.id, req.user.org_id]);
  res.json({ role: result.rows[0] });
});

// ── POST /team/invite — Invite a new team member ─────────────
router.post('/invite', requirePermission('team:invite'), async (req, res) => {
  const { email, role_id, first_name, last_name } = req.body;
  if (!email || !role_id) return res.status(400).json({ error: 'Email and role required' });

  // Verify role belongs to this org
  const roleCheck = await query('SELECT * FROM roles WHERE id=$1 AND org_id=$2', [role_id, req.user.org_id]);
  if (!roleCheck.rows.length) return res.status(400).json({ error: 'Invalid role' });
  if (roleCheck.rows[0].slug === 'owner') return res.status(403).json({ error: 'Cannot invite someone as owner' });

  // Check if already a member
  const existing = await query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
  if (existing.rows.length) return res.status(409).json({ error: 'This email is already registered' });

  // Create user with temp password, force reset on first login
  const tempPassword = uuidv4().replace(/-/g, '').slice(0,12) + 'A1!';
  const passwordHash = await bcrypt.hash(tempPassword, 12);
  const verifyToken = uuidv4();

  const result = await query(`
    INSERT INTO users (org_id, role_id, email, password_hash, first_name, last_name, is_email_verified, email_verify_token)
    VALUES ($1,$2,$3,$4,$5,$6,false,$7) RETURNING id, email, first_name, last_name
  `, [req.user.org_id, role_id, email.toLowerCase(), passwordHash, first_name || '', last_name || '', verifyToken]);

  // Send invite email with temp credentials
  await emailService.sendInvite({
    to: email,
    inviterName: `${req.user.first_name} ${req.user.last_name}`,
    orgName: req.user.org_name,
    roleName: roleCheck.rows[0].name,
    tempPassword,
    loginUrl: `${process.env.APP_URL}/auth/login`,
  }).catch(() => {});

  // Audit log
  await query(`INSERT INTO audit_logs (org_id, user_id, action, resource, details)
    VALUES ($1,$2,'team.invite','user',$3)`,
    [req.user.org_id, req.user.id, JSON.stringify({ invited_email: email, role: roleCheck.rows[0].name })]);

  res.status(201).json({ member: result.rows[0], message: 'Invitation sent' });
});

// ── PUT /team/members/:id — Update member role ────────────────
router.put('/members/:id', requirePermission('team:edit'), async (req, res) => {
  const { role_id } = req.body;
  if (!role_id) return res.status(400).json({ error: 'role_id required' });

  // Cannot change owner's role
  const targetUser = await query('SELECT * FROM users WHERE id=$1 AND org_id=$2', [req.params.id, req.user.org_id]);
  if (!targetUser.rows.length) return res.status(404).json({ error: 'Member not found' });
  if (targetUser.rows[0].is_owner) return res.status(403).json({ error: 'Cannot change owner role' });

  // Verify role belongs to org
  const roleCheck = await query('SELECT * FROM roles WHERE id=$1 AND org_id=$2', [role_id, req.user.org_id]);
  if (!roleCheck.rows.length) return res.status(400).json({ error: 'Invalid role' });
  if (roleCheck.rows[0].slug === 'owner') return res.status(403).json({ error: 'Cannot assign owner role' });

  await query('UPDATE users SET role_id=$1, updated_at=NOW() WHERE id=$2 AND org_id=$3', [role_id, req.params.id, req.user.org_id]);

  await query(`INSERT INTO audit_logs (org_id, user_id, action, resource, resource_id, details)
    VALUES ($1,$2,'team.role_changed','user',$3,$4)`,
    [req.user.org_id, req.user.id, req.params.id, JSON.stringify({ new_role: roleCheck.rows[0].name })]);

  res.json({ message: 'Role updated' });
});

// ── DELETE /team/members/:id — Remove member ──────────────────
router.delete('/members/:id', requirePermission('team:remove'), async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot remove yourself' });

  const targetUser = await query('SELECT * FROM users WHERE id=$1 AND org_id=$2', [req.params.id, req.user.org_id]);
  if (!targetUser.rows.length) return res.status(404).json({ error: 'Member not found' });
  if (targetUser.rows[0].is_owner) return res.status(403).json({ error: 'Cannot remove the org owner' });

  await query('UPDATE users SET is_active=false, updated_at=NOW() WHERE id=$1', [req.params.id]);
  await query('UPDATE refresh_tokens SET revoked=true WHERE user_id=$1', [req.params.id]);

  await query(`INSERT INTO audit_logs (org_id, user_id, action, resource, resource_id, details)
    VALUES ($1,$2,'team.member_removed','user',$3,$4)`,
    [req.user.org_id, req.user.id, req.params.id, JSON.stringify({ removed_email: targetUser.rows[0].email })]);

  res.json({ message: 'Member removed' });
});

// ── PUT /team/members/:id/toggle — Suspend/activate ──────────
router.put('/members/:id/toggle', requirePermission('team:edit'), async (req, res) => {
  const targetUser = await query('SELECT is_active, is_owner FROM users WHERE id=$1 AND org_id=$2', [req.params.id, req.user.org_id]);
  if (!targetUser.rows.length) return res.status(404).json({ error: 'Member not found' });
  if (targetUser.rows[0].is_owner) return res.status(403).json({ error: 'Cannot suspend the owner' });

  const newStatus = !targetUser.rows[0].is_active;
  await query('UPDATE users SET is_active=$1 WHERE id=$2', [newStatus, req.params.id]);
  if (!newStatus) await query('UPDATE refresh_tokens SET revoked=true WHERE user_id=$1', [req.params.id]);

  res.json({ active: newStatus });
});

// ── GET /team/roles/permissions-map — All available permissions
router.get('/roles/permissions-map', requirePermission('team:view'), (req, res) => {
  const map = {
    Dashboard: ['dashboard:view'],
    Stores: ['stores:view','stores:create','stores:edit','stores:delete'],
    Orders: ['orders:view','orders:export','orders:send_wa'],
    Conversations: ['conversations:view','conversations:reply','conversations:assign'],
    'Flow Builder': ['flows:view','flows:create','flows:edit','flows:delete','flows:toggle'],
    Templates: ['templates:view','templates:create','templates:edit','templates:delete'],
    Catalogue: ['catalogue:view','catalogue:create','catalogue:edit','catalogue:delete','catalogue:sync'],
    Broadcasts: ['broadcasts:view','broadcasts:create','broadcasts:send','broadcasts:delete'],
    Analytics: ['analytics:view','analytics:export'],
    Billing: ['billing:view','billing:manage'],
    Settings: ['settings:view','settings:edit'],
    Team: ['team:view','team:invite','team:edit','team:remove'],
    WhatsApp: ['whatsapp:view','whatsapp:setup','whatsapp:manage'],
  };
  res.json({ permissions_map: map });
});

module.exports = router;
