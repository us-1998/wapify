// routes/whatsapp.js
const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const metaService = require('../services/meta');
const crypto = require('crypto');

router.use(authenticate);

router.get('/numbers', requirePermission('whatsapp:view'), async (req, res) => {
  const result = await query('SELECT * FROM whatsapp_numbers WHERE org_id=$1', [req.user.org_id]);
  res.json({ numbers: result.rows });
});

router.post('/numbers', requirePermission('whatsapp:setup'), async (req, res) => {
  const { phone_number, display_name } = req.body;
  if (!phone_number) return res.status(400).json({ error: 'Phone number required' });
  const result = await query(`
    INSERT INTO whatsapp_numbers (org_id, phone_number, display_name, status)
    VALUES ($1,$2,$3,'pending') RETURNING *
  `, [req.user.org_id, phone_number, display_name]);
  res.status(201).json({ number: result.rows[0] });
});

router.post('/numbers/:id/send-otp', requirePermission('whatsapp:setup'), async (req, res) => {
  const { method = 'SMS' } = req.body;
  const num = await query('SELECT * FROM whatsapp_numbers WHERE id=$1 AND org_id=$2', [req.params.id, req.user.org_id]);
  if (!num.rows.length) return res.status(404).json({ error: 'Number not found' });
  try {
    await metaService.requestOTP(num.rows[0].phone_number_id || num.rows[0].phone_number, method);
    res.json({ message: `OTP sent via ${method}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/numbers/:id/verify-otp', requirePermission('whatsapp:setup'), async (req, res) => {
  const { otp } = req.body;
  const num = await query('SELECT * FROM whatsapp_numbers WHERE id=$1 AND org_id=$2', [req.params.id, req.user.org_id]);
  if (!num.rows.length) return res.status(404).json({ error: 'Number not found' });
  try {
    const result = await metaService.verifyOTP(num.rows[0].phone_number_id || num.rows[0].phone_number, otp);
    await query('UPDATE whatsapp_numbers SET status=$1, phone_number_id=$2, verified_at=NOW() WHERE id=$3',
      ['active', result.phone_number_id, req.params.id]);
    res.json({ message: 'Number verified', number_id: result.phone_number_id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Meta webhook verification
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Meta webhook incoming messages
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-hub-signature-256'];
  const expected = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(req.body).digest('hex');
  if (signature !== expected) return res.sendStatus(401);

  const body = JSON.parse(req.body);
  const waQueue = require('../services/waQueue');
  if (body.object === 'whatsapp_business_account') {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field === 'messages') {
          await waQueue.add('incoming_message', { payload: change.value });
        }
      }
    }
  }
  res.sendStatus(200);
});

module.exports = router;
