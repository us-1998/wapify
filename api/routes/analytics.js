// routes/analytics.js
const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');

router.use(authenticate);

router.get('/overview', requirePermission('analytics:view'), async (req, res) => {
  const { period = '30' } = req.query;
  const [orders, messages, rto, revenue] = await Promise.all([
    query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE wa_confirmed=true) AS confirmed,
                  COUNT(*) FILTER (WHERE rto_risk=true) AS rto_risk
           FROM orders WHERE org_id=$1 AND created_at > NOW()-INTERVAL '${period} days'`,
      [req.user.org_id]),
    query(`SELECT COUNT(*) AS sent, COUNT(*) FILTER (WHERE status='delivered') AS delivered,
                  COUNT(*) FILTER (WHERE status='read') AS read_count,
                  COUNT(*) FILTER (WHERE direction='inbound') AS replied
           FROM messages m JOIN conversations c ON c.id=m.conversation_id
           WHERE c.org_id=$1 AND m.created_at > NOW()-INTERVAL '${period} days'`,
      [req.user.org_id]),
    query(`SELECT ROUND(COUNT(*) FILTER (WHERE rto_risk=true)::numeric / NULLIF(COUNT(*),0)*100,1) AS rate
           FROM orders WHERE org_id=$1 AND created_at > NOW()-INTERVAL '${period} days'`,
      [req.user.org_id]),
    query(`SELECT COALESCE(SUM(total),0) AS total FROM orders WHERE org_id=$1
           AND created_at > NOW()-INTERVAL '${period} days'`,
      [req.user.org_id]),
  ]);
  res.json({
    orders: orders.rows[0],
    messages: messages.rows[0],
    rto_rate: rto.rows[0].rate,
    revenue: revenue.rows[0].total,
  });
});

router.get('/rto-trend', requirePermission('analytics:view'), async (req, res) => {
  const result = await query(`
    SELECT DATE_TRUNC('day', created_at) AS day,
           ROUND(COUNT(*) FILTER (WHERE rto_risk=true)::numeric / NULLIF(COUNT(*),0)*100,1) AS rto_pct,
           COUNT(*) AS total_orders
    FROM orders WHERE org_id=$1 AND created_at > NOW()-INTERVAL '30 days'
    GROUP BY 1 ORDER BY 1
  `, [req.user.org_id]);
  res.json({ trend: result.rows });
});

router.get('/message-volume', requirePermission('analytics:view'), async (req, res) => {
  const result = await query(`
    SELECT DATE_TRUNC('day', m.created_at) AS day,
           m.template_name,
           COUNT(*) AS count
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.org_id=$1 AND m.direction='outbound' AND m.created_at > NOW()-INTERVAL '7 days'
    GROUP BY 1,2 ORDER BY 1
  `, [req.user.org_id]);
  res.json({ volume: result.rows });
});

module.exports = router;
