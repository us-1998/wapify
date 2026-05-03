// middleware/auth.js
const jwt = require('jsonwebtoken');
const { query } = require('../config/db');

// ── Verify access token ─────────────────────────────────────
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Load fresh user + role + org from DB
    const result = await query(`
      SELECT u.id, u.email, u.first_name, u.last_name, u.is_owner, u.is_active,
             u.org_id, u.role_id, u.avatar_url,
             r.slug AS role_slug, r.name AS role_name, r.permissions,
             o.plan, o.plan_status, o.msg_quota, o.msg_used, o.name AS org_name,
             o.slug AS org_slug
      FROM users u
      LEFT JOIN roles r ON r.id = u.role_id
      LEFT JOIN organizations o ON o.id = u.org_id
      WHERE u.id = $1 AND u.is_active = true
    `, [decoded.userId]);

    if (!result.rows.length) {
      return res.status(401).json({ error: 'User not found or deactivated' });
    }

    req.user = result.rows[0];
    req.user.permissions = result.rows[0].permissions || {};
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// ── Check a specific permission ──────────────────────────────
// Usage: requirePermission('orders:view')
const requirePermission = (permission) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });

  // Org owner always has full access
  if (req.user.is_owner) return next();

  // Check the permission in role's permission map
  if (req.user.permissions[permission] === true) return next();

  return res.status(403).json({
    error: 'Permission denied',
    required: permission,
    role: req.user.role_slug,
  });
};

// ── Require any of multiple permissions ──────────────────────
// Usage: requireAny('orders:view', 'orders:export')
const requireAny = (...permissions) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
  if (req.user.is_owner) return next();
  const has = permissions.some(p => req.user.permissions[p] === true);
  if (has) return next();
  return res.status(403).json({ error: 'Permission denied', required: permissions });
};

// ── Admin panel auth ─────────────────────────────────────────
const authenticateAdmin = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No admin token' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET);

    const result = await query(
      'SELECT id, email, name, role, is_active FROM admin_users WHERE id=$1',
      [decoded.adminId]
    );
    if (!result.rows.length || !result.rows[0].is_active) {
      return res.status(401).json({ error: 'Admin not found' });
    }
    req.admin = result.rows[0];
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid admin token' });
  }
};

// ── Require admin role ───────────────────────────────────────
const requireAdminRole = (...roles) => (req, res, next) => {
  if (!req.admin) return res.status(401).json({ error: 'Unauthenticated' });
  if (req.admin.role === 'owner') return next();
  if (roles.includes(req.admin.role)) return next();
  return res.status(403).json({ error: 'Insufficient admin role', required: roles });
};

// ── Verify org ownership of a resource ──────────────────────
const requireSameOrg = (paramName = 'orgId') => (req, res, next) => {
  const targetOrgId = req.params[paramName] || req.body[paramName];
  if (targetOrgId && targetOrgId !== req.user.org_id) {
    return res.status(403).json({ error: 'Access to this resource is not allowed' });
  }
  next();
};

module.exports = {
  authenticate,
  requirePermission,
  requireAny,
  authenticateAdmin,
  requireAdminRole,
  requireSameOrg,
};
