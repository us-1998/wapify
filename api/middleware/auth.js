const jwt = require('jsonwebtoken');
const { query } = require('../config/db');

const authenticate = async (req, res, next) => {
  try {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });
    const token = auth.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await query(`
      SELECT u.id,u.email,u.first_name,u.last_name,u.is_owner,u.is_active,u.org_id,u.role_id,u.avatar_url,u.preferences,
             r.slug AS role_slug,r.name AS role_name,r.permissions,
             o.plan,o.plan_status,o.msg_quota,o.msg_used,o.name AS org_name,o.slug AS org_slug,o.max_stores
      FROM users u
      LEFT JOIN roles r ON r.id=u.role_id
      LEFT JOIN organizations o ON o.id=u.org_id
      WHERE u.id=$1 AND u.is_active=true
    `, [decoded.userId]);
    if (!result.rows.length) return res.status(401).json({ error: 'User not found or deactivated' });
    req.user = result.rows[0];
    req.user.permissions = result.rows[0].permissions || {};
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    return res.status(401).json({ error: 'Invalid token' });
  }
};

const requirePermission = (perm) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
  if (req.user.is_owner) return next();
  if (req.user.permissions[perm]) return next();
  return res.status(403).json({ error: 'Permission denied', required: perm, role: req.user.role_slug });
};

const authenticateAdmin = async (req, res, next) => {
  try {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'No admin token' });
    const token = auth.split(' ')[1];
    const decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    const result = await query('SELECT id,email,name,role,is_active FROM admin_users WHERE id=$1 AND is_active=true', [decoded.adminId]);
    if (!result.rows.length) return res.status(401).json({ error: 'Admin not found' });
    req.admin = result.rows[0];
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid admin token' });
  }
};

module.exports = { authenticate, requirePermission, authenticateAdmin };
