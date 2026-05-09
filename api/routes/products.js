// routes/products.js
const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
router.use(authenticate);

router.get('/', requirePermission('catalogue:view'), async (req, res) => {
  const { search, limit=30, page=1 } = req.query;
  const offset = (page-1)*limit;
  const params = [req.user.org_id];
  let where = 'WHERE org_id=$1';
  let i = 2;
  if (search) { where += ` AND name ILIKE $${i++}`; params.push(`%${search}%`); }
  const [rows, count] = await Promise.all([
    query(`SELECT * FROM products ${where} ORDER BY synced_at DESC NULLS LAST LIMIT $${i} OFFSET $${i+1}`, [...params, limit, offset]),
    query(`SELECT COUNT(*) FROM products ${where}`, params),
  ]);
  res.json({ products: rows.rows, total: parseInt(count.rows[0].count) });
});

router.post('/', requirePermission('catalogue:create'), async (req, res) => {
  const { name, price, currency, stock, images, category, description, store_id } = req.body;
  if (!name) return res.status(400).json({ error: 'Product name required' });
  const r = await query(`INSERT INTO products (org_id,store_id,name,description,price,currency,stock,images,category,synced_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,NOW()) RETURNING *`,
    [req.user.org_id, store_id||null, name, description, price||0, currency||'PKR', stock||0,
     JSON.stringify(images||[]), category]);
  res.status(201).json({ product: r.rows[0] });
});

router.put('/:id', requirePermission('catalogue:edit'), async (req, res) => {
  const { name, price, stock, currency, description } = req.body;
  const r = await query(`UPDATE products SET name=COALESCE($1,name),price=COALESCE($2,price),
    stock=COALESCE($3,stock),currency=COALESCE($4,currency),description=COALESCE($5,description),updated_at=NOW()
    WHERE id=$6 AND org_id=$7 RETURNING *`,
    [name,price,stock,currency,description,req.params.id,req.user.org_id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Product not found' });
  res.json({ product: r.rows[0] });
});

router.delete('/:id', requirePermission('catalogue:delete'), async (req, res) => {
  await query('DELETE FROM products WHERE id=$1 AND org_id=$2', [req.params.id, req.user.org_id]);
  res.json({ message: 'Product deleted' });
});

router.post('/:id/send-wa', requirePermission('catalogue:view'), async (req, res) => {
  const { conversation_id } = req.body;
  if (!conversation_id) return res.status(400).json({ error: 'conversation_id required' });
  const prod = await query('SELECT * FROM products WHERE id=$1 AND org_id=$2', [req.params.id, req.user.org_id]);
  if (!prod.rows.length) return res.status(404).json({ error: 'Product not found' });
  const p = prod.rows[0];
  const cv = await query(`SELECT cv.*,wa.phone_number_id,c.phone FROM conversations cv
    JOIN whatsapp_numbers wa ON wa.id=cv.whatsapp_number_id
    JOIN customers c ON c.id=cv.customer_id
    WHERE cv.id=$1 AND cv.org_id=$2`, [conversation_id, req.user.org_id]);
  if (!cv.rows.length) return res.status(404).json({ error: 'Conversation not found' });
  const meta = require('../services/meta');
  const msg = `📦 *${p.name}*\n💰 ${p.currency} ${p.price}\n📊 Stock: ${p.stock} units${p.description?'\n\n'+p.description:''}`;
  await meta.sendText(cv.rows[0].phone_number_id, cv.rows[0].phone, msg);
  res.json({ message: 'Product sent on WhatsApp' });
});

module.exports = router;
