// routes/orders.js
const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');

router.use(authenticate);

// GET /orders
router.get('/', requirePermission('orders:view'), async (req, res) => {
  const { status, store_id, payment_method, search, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;
  const conditions = ['o.org_id = $1'];
  const params = [req.user.org_id];
  let i = 2;
  if (status) { conditions.push(`o.status = $${i++}`); params.push(status); }
  if (store_id) { conditions.push(`o.store_id = $${i++}`); params.push(store_id); }
  if (payment_method) { conditions.push(`o.payment_method = $${i++}`); params.push(payment_method); }
  if (search) { conditions.push(`(c.name ILIKE $${i} OR c.phone ILIKE $${i} OR o.order_number ILIKE $${i})`); params.push(`%${search}%`); i++; }

  const where = conditions.join(' AND ');
  const result = await query(`
    SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, s.name AS store_name
    FROM orders o
    LEFT JOIN customers c ON c.id = o.customer_id
    LEFT JOIN stores s ON s.id = o.store_id
    WHERE ${where}
    ORDER BY o.created_at DESC
    LIMIT $${i} OFFSET $${i+1}
  `, [...params, limit, offset]);

  const count = await query(`SELECT COUNT(*) FROM orders o LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN stores s ON s.id=o.store_id WHERE ${where}`, params);
  res.json({ orders: result.rows, total: parseInt(count.rows[0].count), page: +page, limit: +limit });
});

// GET /orders/:id
router.get('/:id', requirePermission('orders:view'), async (req, res) => {
  const result = await query(`
    SELECT o.*, c.name AS customer_name, c.phone, c.email AS customer_email, s.name AS store_name, s.platform
    FROM orders o LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN stores s ON s.id=o.store_id
    WHERE o.id=$1 AND o.org_id=$2
  `, [req.params.id, req.user.org_id]);
  if (!result.rows.length) return res.status(404).json({ error: 'Order not found' });
  res.json({ order: result.rows[0] });
});

// POST /orders/:id/send-wa — Manual send WhatsApp
router.post('/:id/send-wa', requirePermission('orders:send_wa'), async (req, res) => {
  const order = await query('SELECT * FROM orders WHERE id=$1 AND org_id=$2', [req.params.id, req.user.org_id]);
  if (!order.rows.length) return res.status(404).json({ error: 'Order not found' });
  await query('UPDATE orders SET wa_status=$1 WHERE id=$2', ['queued', req.params.id]);
  // In production: add to BullMQ queue
  res.json({ message: 'WhatsApp message queued' });
});

// GET /orders/stats/summary
router.get('/stats/summary', requirePermission('orders:view'), async (req, res) => {
  const result = await query(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE wa_confirmed=true) AS confirmed,
      COUNT(*) FILTER (WHERE rto_risk=true) AS rto_risk,
      COUNT(*) FILTER (WHERE status='pending') AS pending,
      COALESCE(SUM(total),0) AS revenue
    FROM orders WHERE org_id=$1
    AND created_at > NOW() - INTERVAL '30 days'
  `, [req.user.org_id]);
  res.json(result.rows[0]);
});

module.exports = router;
