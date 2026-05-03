// routes/stores.js
const express = require('express');
const router = express.Router();
const { query, transaction } = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const crypto = require('crypto');

router.use(authenticate);

router.get('/', requirePermission('stores:view'), async (req, res) => {
  const result = await query(`
    SELECT s.*, wa.phone_number AS wa_phone, wa.status AS wa_status,
           (SELECT COUNT(*) FROM orders WHERE store_id=s.id AND created_at > NOW()-INTERVAL '1 day') AS orders_today
    FROM stores s
    LEFT JOIN whatsapp_numbers wa ON wa.id = s.whatsapp_number_id
    WHERE s.org_id = $1 ORDER BY s.created_at ASC
  `, [req.user.org_id]);
  res.json({ stores: result.rows });
});

router.post('/', requirePermission('stores:create'), async (req, res) => {
  const { name, platform, domain } = req.body;
  if (!name || !platform) return res.status(400).json({ error: 'Name and platform required' });
  const webhookSecret = crypto.randomBytes(32).toString('hex');
  const result = await query(`
    INSERT INTO stores (org_id, name, platform, domain, webhook_secret)
    VALUES ($1,$2,$3,$4,$5) RETURNING *
  `, [req.user.org_id, name, platform, domain, webhookSecret]);
  res.status(201).json({ store: result.rows[0] });
});

router.put('/:id', requirePermission('stores:edit'), async (req, res) => {
  const { name, woo_url, woo_consumer_key, woo_consumer_secret,
          bc_store_hash, bc_access_token, shopify_shop, shopify_access_token,
          auto_cod_confirm, auto_tracking, auto_cart_recovery, auto_review_request } = req.body;
  const result = await query(`
    UPDATE stores SET
      name=COALESCE($1,name), woo_url=COALESCE($2,woo_url),
      woo_consumer_key=COALESCE($3,woo_consumer_key), woo_consumer_secret=COALESCE($4,woo_consumer_secret),
      bc_store_hash=COALESCE($5,bc_store_hash), bc_access_token=COALESCE($6,bc_access_token),
      shopify_shop=COALESCE($7,shopify_shop), shopify_access_token=COALESCE($8,shopify_access_token),
      auto_cod_confirm=COALESCE($9,auto_cod_confirm), auto_tracking=COALESCE($10,auto_tracking),
      auto_cart_recovery=COALESCE($11,auto_cart_recovery), auto_review_request=COALESCE($12,auto_review_request),
      updated_at=NOW()
    WHERE id=$13 AND org_id=$14 RETURNING *
  `, [name,woo_url,woo_consumer_key,woo_consumer_secret,bc_store_hash,bc_access_token,
      shopify_shop,shopify_access_token,auto_cod_confirm,auto_tracking,auto_cart_recovery,
      auto_review_request,req.params.id,req.user.org_id]);
  if (!result.rows.length) return res.status(404).json({ error: 'Store not found' });
  res.json({ store: result.rows[0] });
});

router.delete('/:id', requirePermission('stores:delete'), async (req, res) => {
  await query('UPDATE stores SET status=$1 WHERE id=$2 AND org_id=$3', ['disconnected', req.params.id, req.user.org_id]);
  res.json({ message: 'Store disconnected' });
});

// Shopify OAuth callback
router.get('/shopify/callback', async (req, res) => {
  const { shop, code } = req.query;
  if (!shop || !code) return res.status(400).json({ error: 'Missing params' });
  try {
    const axios = require('axios');
    const tokenRes = await axios.post(`https://${shop}/admin/oauth/access_token`, {
      client_id: process.env.SHOPIFY_API_KEY,
      client_secret: process.env.SHOPIFY_API_SECRET,
      code,
    });
    const accessToken = tokenRes.data.access_token;
    // Store the token (org from session/state)
    res.json({ shop, access_token: accessToken, message: 'Shopify connected' });
  } catch (err) {
    res.status(500).json({ error: 'OAuth failed' });
  }
});

// Webhook from Shopify
router.post('/webhooks/shopify/:storeId', express.raw({ type: 'application/json' }), async (req, res) => {
  const storeId = req.params.storeId;
  const hmac = req.headers['x-shopify-hmac-sha256'];
  const store = await query('SELECT * FROM stores WHERE id=$1', [storeId]);
  if (!store.rows.length) return res.sendStatus(404);

  const digest = crypto.createHmac('sha256', process.env.SHOPIFY_API_SECRET)
    .update(req.body).digest('base64');
  if (digest !== hmac) return res.sendStatus(401);

  const topic = req.headers['x-shopify-topic'];
  const data = JSON.parse(req.body);
  const waQueue = require('../services/waQueue');

  if (topic === 'orders/create') {
    await waQueue.add('new_order', { storeId, orgId: store.rows[0].org_id, order: data });
  } else if (topic === 'orders/updated') {
    await waQueue.add('order_updated', { storeId, orgId: store.rows[0].org_id, order: data });
  } else if (topic === 'checkouts/create') {
    await waQueue.add('cart_abandoned', { storeId, orgId: store.rows[0].org_id, checkout: data });
  }

  res.sendStatus(200);
});

module.exports = router;
