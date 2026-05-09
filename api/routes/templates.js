// routes/templates.js
const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
router.use(authenticate);

router.get('/', requirePermission('templates:view'), async (req, res) => {
  const r = await query('SELECT * FROM templates WHERE org_id=$1 ORDER BY created_at DESC', [req.user.org_id]);
  res.json({ templates: r.rows });
});

router.post('/', requirePermission('templates:create'), async (req, res) => {
  const { name, category, language, content, header, footer, buttons } = req.body;
  if (!name || !content) return res.status(400).json({ error: 'Name and content required' });
  const r = await query(`INSERT INTO templates (org_id,name,category,language,content,header,footer,buttons,status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'pending') RETURNING *`,
    [req.user.org_id, name, category||'UTILITY', language||'en', content, header, footer, JSON.stringify(buttons||[])]);
  res.status(201).json({ template: r.rows[0] });
});

router.put('/:id', requirePermission('templates:edit'), async (req, res) => {
  const { name, content, header, footer, buttons } = req.body;
  const r = await query(`UPDATE templates SET name=COALESCE($1,name),content=COALESCE($2,content),
    header=COALESCE($3,header),footer=COALESCE($4,footer),buttons=COALESCE($5::jsonb,buttons),
    status='pending',updated_at=NOW() WHERE id=$6 AND org_id=$7 RETURNING *`,
    [name,content,header,footer,buttons?JSON.stringify(buttons):null,req.params.id,req.user.org_id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Template not found' });
  res.json({ template: r.rows[0] });
});

router.delete('/:id', requirePermission('templates:delete'), async (req, res) => {
  await query('DELETE FROM templates WHERE id=$1 AND org_id=$2', [req.params.id, req.user.org_id]);
  res.json({ message: 'Template deleted' });
});

module.exports = router;
