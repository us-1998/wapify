// routes/broadcasts.js
const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
router.use(authenticate);

router.get('/', requirePermission('broadcasts:view'), async (req, res) => {
  const r = await query('SELECT * FROM broadcasts WHERE org_id=$1 ORDER BY created_at DESC', [req.user.org_id]);
  res.json({ broadcasts: r.rows });
});

router.post('/', requirePermission('broadcasts:create'), async (req, res) => {
  const { name, segment, template_name, scheduled_at } = req.body;
  if (!name) return res.status(400).json({ error: 'Campaign name required' });

  // Count audience
  let audienceQ = 'SELECT COUNT(*) FROM customers WHERE org_id=$1 AND opted_in=true';
  const audienceParams = [req.user.org_id];
  if (segment === 'cod') audienceQ += ' AND id IN (SELECT DISTINCT customer_id FROM orders WHERE payment_method=\'cod\')';
  else if (segment === 'vip') audienceQ += ' AND total_orders>=3';
  else if (segment === 'unconfirmed') audienceQ += ' AND id IN (SELECT DISTINCT customer_id FROM orders WHERE wa_confirmed IS NULL AND payment_method=\'cod\' AND created_at>NOW()-INTERVAL \'7 days\')';
  const cnt = await query(audienceQ, audienceParams);
  const total = parseInt(cnt.rows[0].count);

  const r = await query(`INSERT INTO broadcasts (org_id,name,template_name,segment,status,scheduled_at,total,created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [req.user.org_id, name, template_name, segment, scheduled_at?'scheduled':'draft', scheduled_at||null, total, req.user.id]);

  res.status(201).json({ broadcast: r.rows[0], audience_count: total });
});

router.post('/:id/send', requirePermission('broadcasts:send'), async (req, res) => {
  const bc = await query('SELECT * FROM broadcasts WHERE id=$1 AND org_id=$2', [req.params.id, req.user.org_id]);
  if (!bc.rows.length) return res.status(404).json({ error: 'Broadcast not found' });
  if (bc.rows[0].status === 'sent') return res.status(400).json({ error: 'Already sent' });

  // Check org quota
  const org = await query('SELECT msg_used, msg_quota FROM organizations WHERE id=$1', [req.user.org_id]);
  const remaining = org.rows[0].msg_quota - org.rows[0].msg_used;
  if (bc.rows[0].total > remaining) return res.status(403).json({ error: `Insufficient message quota. Need ${bc.rows[0].total}, have ${remaining} remaining.` });

  await query("UPDATE broadcasts SET status='sending',sent_at=NOW() WHERE id=$1", [req.params.id]);

  // Get WA number
  const waNum = await query("SELECT * FROM whatsapp_numbers WHERE org_id=$1 AND status='active' LIMIT 1", [req.user.org_id]);
  if (!waNum.rows.length) {
    await query("UPDATE broadcasts SET status='failed' WHERE id=$1", [req.params.id]);
    return res.status(400).json({ error: 'No active WhatsApp number. Complete WhatsApp setup first.' });
  }

  // Queue send jobs async
  sendBroadcast(bc.rows[0], waNum.rows[0], req.user.org_id).catch(console.error);
  res.json({ message: `Sending to ${bc.rows[0].total} customers…`, broadcast_id: req.params.id });
});

router.delete('/:id', requirePermission('broadcasts:delete'), async (req, res) => {
  const bc = await query('SELECT status FROM broadcasts WHERE id=$1 AND org_id=$2', [req.params.id, req.user.org_id]);
  if (!bc.rows.length) return res.status(404).json({ error: 'Not found' });
  if (bc.rows[0].status === 'sending') return res.status(400).json({ error: 'Cannot delete a broadcast that is currently sending' });
  await query('DELETE FROM broadcasts WHERE id=$1', [req.params.id]);
  res.json({ message: 'Broadcast deleted' });
});

async function sendBroadcast(broadcast, waNum, orgId) {
  const meta = require('../services/meta');
  let audienceQ = 'SELECT id,phone,name,language FROM customers WHERE org_id=$1 AND opted_in=true AND phone IS NOT NULL';
  const params = [orgId];
  if (broadcast.segment === 'cod') audienceQ += ' AND id IN (SELECT DISTINCT customer_id FROM orders WHERE payment_method=\'cod\')';
  else if (broadcast.segment === 'vip') audienceQ += ' AND total_orders>=3';
  else if (broadcast.segment === 'unconfirmed') audienceQ += ' AND id IN (SELECT DISTINCT customer_id FROM orders WHERE wa_confirmed IS NULL AND payment_method=\'cod\' AND created_at>NOW()-INTERVAL \'7 days\')';
  const customers = await query(audienceQ, params);

  let delivered = 0; let failed = 0;
  for (const c of customers.rows) {
    try {
      await meta.sendTemplate(waNum.phone_number_id, c.phone, broadcast.template_name, c.language || 'en');
      delivered++;
      await query('UPDATE organizations SET msg_used=msg_used+1 WHERE id=$1', [orgId]);
      await new Promise(r => setTimeout(r, 100)); // rate limit
    } catch { failed++; }
  }
  await query("UPDATE broadcasts SET status='sent',delivered=$1,failed=$2 WHERE id=$3", [delivered, failed, broadcast.id]);
}

module.exports = router;
