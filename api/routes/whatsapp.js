// routes/whatsapp.js
const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const meta = require('../services/meta');
const crypto = require('crypto');
router.use('/webhook', express.raw({ type: 'application/json' }));
router.use((req, res, next) => { if (req.path === '/webhook' && req.method === 'GET') return next(); authenticate(req, res, next); });

router.get('/numbers', requirePermission('whatsapp:view'), async (req, res) => {
  const r = await query('SELECT * FROM whatsapp_numbers WHERE org_id=$1 ORDER BY created_at', [req.user.org_id]);
  res.json({ numbers: r.rows });
});

router.post('/numbers', requirePermission('whatsapp:setup'), async (req, res) => {
  const { phone_number, display_name } = req.body;
  if (!phone_number) return res.status(400).json({ error: 'Phone number required' });
  const r = await query(`INSERT INTO whatsapp_numbers (org_id,phone_number,display_name,status)
    VALUES ($1,$2,$3,'pending') ON CONFLICT (phone_number_id) DO NOTHING RETURNING *`,
    [req.user.org_id, phone_number, display_name || req.user.org_name]);
  res.status(201).json({ number: r.rows[0] });
});

router.post('/numbers/:id/send-otp', requirePermission('whatsapp:setup'), async (req, res) => {
  const { method = 'SMS' } = req.body;
  const num = await query('SELECT * FROM whatsapp_numbers WHERE id=$1 AND org_id=$2', [req.params.id, req.user.org_id]);
  if (!num.rows.length) return res.status(404).json({ error: 'Number not found' });
  if (!num.rows[0].phone_number_id) return res.status(400).json({ error: 'Phone number ID not set. Register this number in Meta Developer Console first.' });
  try {
    await meta.requestOTP(num.rows[0].phone_number_id, method);
    res.json({ message: `OTP sent via ${method}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/numbers/:id/verify-otp', requirePermission('whatsapp:setup'), async (req, res) => {
  const { otp } = req.body;
  if (!otp) return res.status(400).json({ error: 'OTP required' });
  const num = await query('SELECT * FROM whatsapp_numbers WHERE id=$1 AND org_id=$2', [req.params.id, req.user.org_id]);
  if (!num.rows.length) return res.status(404).json({ error: 'Number not found' });
  try {
    const result = await meta.verifyOTP(num.rows[0].phone_number_id, otp);
    await query("UPDATE whatsapp_numbers SET status='active',verified_at=NOW() WHERE id=$1", [req.params.id]);
    res.json({ message: 'Number verified successfully', result });
  } catch (err) {
    res.status(400).json({ error: 'OTP verification failed: ' + err.message });
  }
});

// Meta webhook verification
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

// Meta incoming messages
router.post('/webhook', async (req, res) => {
  const sig = req.headers['x-hub-signature-256'];
  const expected = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET || '').update(req.body).digest('hex');
  if (sig && sig !== expected) return res.sendStatus(401);
  const body = JSON.parse(req.body);
  if (body.object === 'whatsapp_business_account') {
    const wq = require('../services/waQueue');
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field === 'messages') {
          await wq.add('incoming_message', { payload: change.value });
        }
      }
    }
  }
  res.sendStatus(200);
});

module.exports = router;
