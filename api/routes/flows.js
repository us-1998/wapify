// routes/flows.js
const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
router.use(authenticate);

router.get('/', requirePermission('flows:view'), async (req, res) => {
  const result = await query(`SELECT f.*, s.name AS store_name FROM flows f
    LEFT JOIN stores s ON s.id=f.store_id WHERE f.org_id=$1 ORDER BY f.created_at DESC`, [req.user.org_id]);
  res.json({ flows: result.rows });
});

router.post('/', requirePermission('flows:create'), async (req, res) => {
  const { name, trigger, nodes, store_id, description, settings } = req.body;
  if (!name || !trigger) return res.status(400).json({ error: 'Name and trigger required' });
  const result = await query(`INSERT INTO flows (org_id,store_id,name,description,trigger,nodes,settings,status,created_by)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'draft',$8) RETURNING *`,
    [req.user.org_id, store_id, name, description, trigger, JSON.stringify(nodes||[]), JSON.stringify(settings||{}), req.user.id]);
  res.status(201).json({ flow: result.rows[0] });
});

router.put('/:id', requirePermission('flows:edit'), async (req, res) => {
  const { name, nodes, settings, description } = req.body;
  const result = await query(`UPDATE flows SET name=COALESCE($1,name), description=COALESCE($2,description),
    nodes=COALESCE($3::jsonb,nodes), settings=COALESCE($4::jsonb,settings), updated_at=NOW()
    WHERE id=$5 AND org_id=$6 RETURNING *`,
    [name, description, nodes?JSON.stringify(nodes):null, settings?JSON.stringify(settings):null, req.params.id, req.user.org_id]);
  if (!result.rows.length) return res.status(404).json({ error: 'Flow not found' });
  res.json({ flow: result.rows[0] });
});

router.put('/:id/toggle', requirePermission('flows:toggle'), async (req, res) => {
  const flow = await query('SELECT status FROM flows WHERE id=$1 AND org_id=$2', [req.params.id, req.user.org_id]);
  if (!flow.rows.length) return res.status(404).json({ error: 'Flow not found' });
  const newStatus = flow.rows[0].status === 'active' ? 'paused' : 'active';
  await query('UPDATE flows SET status=$1 WHERE id=$2', [newStatus, req.params.id]);
  res.json({ status: newStatus });
});

router.delete('/:id', requirePermission('flows:delete'), async (req, res) => {
  await query('UPDATE flows SET status=$1 WHERE id=$2 AND org_id=$3', ['archived', req.params.id, req.user.org_id]);
  res.json({ message: 'Flow archived' });
});

module.exports = router;
