// routes/analytics.js
const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
router.use(authenticate);

router.get('/overview', requirePermission('analytics:view'), async (req, res) => {
  const { period = '30' } = req.query;
  const [orders, messages, revenue] = await Promise.all([
    query(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE wa_confirmed=true)::int AS confirmed,
      COUNT(*) FILTER (WHERE rto_risk=true)::int AS rto_risk,
      ROUND(COUNT(*) FILTER (WHERE rto_risk=true)::numeric/NULLIF(COUNT(*),0)*100,1) AS rto_rate
      FROM orders WHERE org_id=$1 AND created_at>NOW()-INTERVAL '${period} days'`, [req.user.org_id]),
    query(`SELECT COUNT(*)::int AS sent,COUNT(*) FILTER (WHERE status='delivered')::int AS delivered,
      COUNT(*) FILTER (WHERE status='read')::int AS read_count,
      COUNT(*) FILTER (WHERE direction='inbound')::int AS replied
      FROM messages m JOIN conversations c ON c.id=m.conversation_id
      WHERE c.org_id=$1 AND m.created_at>NOW()-INTERVAL '${period} days'`, [req.user.org_id]),
    query(`SELECT COALESCE(SUM(total),0) AS total FROM orders WHERE org_id=$1 AND created_at>NOW()-INTERVAL '${period} days'`, [req.user.org_id]),
  ]);
  res.json({ orders: orders.rows[0], messages: messages.rows[0], rto_rate: orders.rows[0].rto_rate, revenue: revenue.rows[0].total });
});

router.get('/rto-trend', requirePermission('analytics:view'), async (req, res) => {
  const r = await query(`SELECT DATE_TRUNC('day',created_at) AS day,
    ROUND(COUNT(*) FILTER (WHERE rto_risk=true)::numeric/NULLIF(COUNT(*),0)*100,1) AS rto_pct,
    COUNT(*)::int AS total_orders
    FROM orders WHERE org_id=$1 AND created_at>NOW()-INTERVAL '30 days'
    GROUP BY 1 ORDER BY 1`, [req.user.org_id]);
  res.json({ trend: r.rows });
});

router.get('/message-volume', requirePermission('analytics:view'), async (req, res) => {
  const r = await query(`SELECT DATE_TRUNC('day',m.created_at) AS day,
    m.template_name,COUNT(*)::int AS count
    FROM messages m JOIN conversations c ON c.id=m.conversation_id
    WHERE c.org_id=$1 AND m.direction='outbound' AND m.created_at>NOW()-INTERVAL '7 days'
    GROUP BY 1,2 ORDER BY 1`, [req.user.org_id]);
  res.json({ volume: r.rows });
});

module.exports = router;
