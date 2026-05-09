// routes/conversations.js
const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const meta = require('../services/meta');
router.use(authenticate);

router.get('/', requirePermission('conversations:view'), async (req, res) => {
  const { status, assigned_to, search, page=1, limit=50 } = req.query;
  const offset = (page-1)*limit;
  const params = [req.user.org_id];
  let where = 'WHERE cv.org_id=$1';
  let i = 2;
  if (status)      { where += ` AND cv.status=$${i++}`;      params.push(status); }
  if (assigned_to) { where += ` AND cv.assigned_to=$${i++}`; params.push(assigned_to); }
  if (search)      { where += ` AND (c.name ILIKE $${i} OR c.phone ILIKE $${i})`; params.push(`%${search}%`); i++; }
  const r = await query(`
    SELECT cv.*,c.name AS customer_name,c.phone AS customer_phone,c.language,
           u.first_name||' '||u.last_name AS assigned_name,wa.phone_number AS wa_phone
    FROM conversations cv
    LEFT JOIN customers c ON c.id=cv.customer_id
    LEFT JOIN users u ON u.id=cv.assigned_to
    LEFT JOIN whatsapp_numbers wa ON wa.id=cv.whatsapp_number_id
    ${where} ORDER BY cv.last_message_at DESC NULLS LAST LIMIT $${i} OFFSET $${i+1}`,
    [...params, limit, offset]);
  res.json({ conversations: r.rows });
});

router.get('/:id/messages', requirePermission('conversations:view'), async (req, res) => {
  const cv = await query('SELECT id FROM conversations WHERE id=$1 AND org_id=$2', [req.params.id, req.user.org_id]);
  if (!cv.rows.length) return res.status(404).json({ error: 'Conversation not found' });
  const msgs = await query(`
    SELECT m.*,u.first_name||' '||u.last_name AS sent_by_name
    FROM messages m LEFT JOIN users u ON u.id=m.sent_by
    WHERE m.conversation_id=$1 ORDER BY m.sent_at ASC`, [req.params.id]);
  await query('UPDATE conversations SET unread_count=0 WHERE id=$1', [req.params.id]);
  res.json({ messages: msgs.rows });
});

router.post('/:id/reply', requirePermission('conversations:reply'), async (req, res) => {
  const { content, type='text' } = req.body;
  if (!content) return res.status(400).json({ error: 'Content required' });
  const cv = await query(`
    SELECT cv.*,wa.phone_number_id,c.phone AS customer_phone
    FROM conversations cv
    JOIN whatsapp_numbers wa ON wa.id=cv.whatsapp_number_id
    JOIN customers c ON c.id=cv.customer_id
    WHERE cv.id=$1 AND cv.org_id=$2`, [req.params.id, req.user.org_id]);
  if (!cv.rows.length) return res.status(404).json({ error: 'Conversation not found' });
  if (!cv.rows[0].phone_number_id) return res.status(400).json({ error: 'No WhatsApp number configured for this conversation' });
  try {
    const msgRes = await meta.sendText(cv.rows[0].phone_number_id, cv.rows[0].customer_phone, content);
    const saved = await query(`
      INSERT INTO messages (org_id,conversation_id,wa_message_id,direction,type,content,status,sent_by)
      VALUES ($1,$2,$3,'outbound',$4,$5,'sent',$6) RETURNING *`,
      [req.user.org_id, req.params.id, msgRes.messages?.[0]?.id, type, content, req.user.id]);
    await query('UPDATE conversations SET last_message=$1,last_message_at=NOW() WHERE id=$2', [content, req.params.id]);
    await query('UPDATE organizations SET msg_used=msg_used+1 WHERE id=$1', [req.user.org_id]);
    res.json({ message: saved.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send: ' + err.message });
  }
});

router.put('/:id/assign', requirePermission('conversations:assign'), async (req, res) => {
  const { user_id } = req.body;
  const r = await query('UPDATE conversations SET assigned_to=$1,updated_at=NOW() WHERE id=$2 AND org_id=$3 RETURNING *',
    [user_id||null, req.params.id, req.user.org_id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  res.json({ conversation: r.rows[0] });
});

router.put('/:id/status', requirePermission('conversations:reply'), async (req, res) => {
  const { status } = req.body;
  if (!['open','pending','resolved','bot'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  await query('UPDATE conversations SET status=$1,updated_at=NOW() WHERE id=$2 AND org_id=$3', [status, req.params.id, req.user.org_id]);
  res.json({ status });
});

module.exports = router;
