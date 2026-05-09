// routes/orders.js
const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
router.use(authenticate);

router.get('/', requirePermission('orders:view'), async (req, res) => {
  const { page=1, limit=25, status, payment_method, search } = req.query;
  const offset = (page-1)*limit;
  const params = [req.user.org_id];
  let where = 'WHERE o.org_id=$1';
  let i = 2;
  if (status)         { where += ` AND o.status=$${i++}`;          params.push(status); }
  if (payment_method) { where += ` AND o.payment_method=$${i++}`;  params.push(payment_method); }
  if (search)         { where += ` AND (c.name ILIKE $${i} OR c.phone ILIKE $${i} OR o.order_number ILIKE $${i})`; params.push(`%${search}%`); i++; }
  const [rows, count] = await Promise.all([
    query(`SELECT o.*,c.name AS customer_name,c.phone AS customer_phone,s.name AS store_name,s.platform
           FROM orders o LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN stores s ON s.id=o.store_id
           ${where} ORDER BY o.created_at DESC LIMIT $${i} OFFSET $${i+1}`, [...params, limit, offset]),
    query(`SELECT COUNT(*) FROM orders o LEFT JOIN customers c ON c.id=o.customer_id ${where}`, params),
  ]);
  res.json({ orders: rows.rows, total: parseInt(count.rows[0].count), page: +page, limit: +limit });
});

router.get('/stats/summary', requirePermission('orders:view'), async (req, res) => {
  const r = await query(`SELECT
    COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE wa_confirmed=true)::int AS confirmed,
    COUNT(*) FILTER (WHERE rto_risk=true)::int AS rto_risk,
    COALESCE(SUM(total),0) AS revenue,
    ROUND(COUNT(*) FILTER (WHERE rto_risk=true)::numeric/NULLIF(COUNT(*),0)*100,1) AS rto_rate
    FROM orders WHERE org_id=$1 AND created_at>NOW()-INTERVAL '30 days'`, [req.user.org_id]);
  res.json(r.rows[0]);
});

router.get('/:id', requirePermission('orders:view'), async (req, res) => {
  const r = await query(`SELECT o.*,c.name AS customer_name,c.phone AS customer_phone,c.email AS customer_email,s.name AS store_name,s.platform
    FROM orders o LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN stores s ON s.id=o.store_id
    WHERE o.id=$1 AND o.org_id=$2`, [req.params.id, req.user.org_id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Order not found' });
  res.json({ order: r.rows[0] });
});

router.post('/:id/send-wa', requirePermission('orders:send_wa'), async (req, res) => {
  const ord = await query('SELECT * FROM orders WHERE id=$1 AND org_id=$2', [req.params.id, req.user.org_id]);
  if (!ord.rows.length) return res.status(404).json({ error: 'Order not found' });
  const wq = require('../services/waQueue');
  await wq.add('send_wa', { orderId: req.params.id, orgId: req.user.org_id });
  await query("UPDATE orders SET wa_status='queued' WHERE id=$1", [req.params.id]);
  res.json({ message: 'WhatsApp message queued' });
});

module.exports = router;
