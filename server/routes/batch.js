// ===== 批量操作中心路由 =====
const express = require('express');
const { repos } = require('../repositories');
const { requireTenant } = require('../repositories/tenant-context');
const { dayPrefix } = require('../repositories/sql');
const { authRequired, asyncH, requireRole } = require('../middleware');
const { generatePreview, executeBatch } = require('../batch');
const { todayLocal } = require('../util');

const router = express.Router();
router.use(authRequired);
router.use('/batch-operations', requireRole('boss', 'admin'));

const ADMIN_ROLES = ['boss', 'admin'];

async function logAudit(userId, action, targetId, detail, ip) {
  const t = requireTenant();
  await repos.adapter.run(
    'INSERT INTO audit_logs (tenant_id, user_id, action, target_type, target_id, detail_json, ip_address) VALUES (?,?,?,?,?,?,?)',
    [t, userId || null, action, 'batch', targetId ? String(targetId) : null, detail ? JSON.stringify(detail) : null, ip || null]
  );
}

router.get('/batch-operations', asyncH(async (req, res) => {
  const t = requireTenant();
  const limit = Math.min(100, Number(req.query.limit) || 30);
  let query = 'SELECT * FROM batch_operations WHERE tenant_id=?';
  const conditions = [], params = [t];
  if (req.query.status) { conditions.push('status=?'); params.push(req.query.status); }
  if (conditions.length) query += ' AND ' + conditions.join(' AND ');
  query += ' ORDER BY created_at DESC LIMIT ?';
  const ops = await repos.adapter.all(query, [...params, limit]);
  res.json({
    operations: ops.map(o => ({
      ...o,
      target_ids: o.target_ids ? JSON.parse(o.target_ids) : [],
      filters_json: o.filters_json ? JSON.parse(o.filters_json) : null,
      params_json: o.params_json ? JSON.parse(o.params_json) : null,
      preview_mode: !!o.preview_mode
    }))
  });
}));

router.post('/batch-operations', asyncH(async (req, res) => {
  const t = requireTenant();
  if (!ADMIN_ROLES.includes(req.user.role || 'member')) return res.status(403).json({ error: '仅管理员可创建批量操作' });
  const { name, action_type, target_type, target_ids, filters, params } = req.body;
  if (!name || !action_type || !target_type) return res.status(400).json({ error: '名称、操作类型、目标范围不能为空' });
  const validActions = ['adjust_price', 'pause', 'add_budget', 'resume'];
  if (!validActions.includes(action_type)) return res.status(400).json({ error: `操作类型须为: ${validActions.join(', ')}` });

  const info = await repos.adapter.run(
    'INSERT INTO batch_operations (tenant_id, name, action_type, target_type, target_ids, filters_json, params_json, status, created_by) VALUES (?,?,?,?,?,?,?,?,?)',
    [t, name, action_type, target_type, target_ids ? JSON.stringify(target_ids) : null, filters ? JSON.stringify(filters) : null, params ? JSON.stringify(params) : null, 'draft', req.user.id]
  );
  await logAudit(req.user.id, 'batch_create', info.lastInsertRowid, { name, action_type }, req.ip);
  res.json({ operation: await repos.adapter.get('SELECT * FROM batch_operations WHERE id=? AND tenant_id=?', [info.lastInsertRowid, t]) });
}));

router.post('/batch-operations/:id/preview', asyncH(async (req, res) => {
  const t = requireTenant();
  if (!ADMIN_ROLES.includes(req.user.role || 'member')) return res.status(403).json({ error: '仅管理员可预览' });
  const op = await repos.adapter.get('SELECT * FROM batch_operations WHERE id=? AND tenant_id=?', [req.params.id, t]);
  if (!op) return res.status(404).json({ error: '批量操作不存在' });

  await repos.adapter.run('DELETE FROM batch_items WHERE batch_id=? AND tenant_id=?', [req.params.id, t]);

  const items = await generatePreview(op);
  for (const item of items) {
    await repos.adapter.run(
      'INSERT INTO batch_items (tenant_id, batch_id, shop_id, campaign_id, shop_name, campaign_name, action_type, current_value, target_value, status) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [t, req.params.id, item.shop_id, item.campaign_id, item.shop_name, item.campaign_name, item.action_type, item.current_value, item.target_value, 'pending']
    );
  }

  await repos.adapter.run('UPDATE batch_operations SET status=?, total_items=?, preview_mode=1 WHERE id=? AND tenant_id=?', ['previewed', items.length, req.params.id, t]);

  res.json({ message: `预览完成，共 ${items.length} 项操作`, total_items: items.length, items: items.slice(0, 50) });
}));

router.get('/batch-operations/:id/items', asyncH(async (req, res) => {
  const t = requireTenant();
  const limit = Math.min(500, Number(req.query.limit) || 100);
  const items = await repos.adapter.all('SELECT * FROM batch_items WHERE batch_id=? AND tenant_id=? ORDER BY id LIMIT ?', [req.params.id, t, limit]);
  res.json({ items });
}));

router.post('/batch-operations/:id/confirm', asyncH(async (req, res) => {
  const t = requireTenant();
  if (!ADMIN_ROLES.includes(req.user.role || 'member')) return res.status(403).json({ error: '仅管理员可确认' });
  const op = await repos.adapter.get('SELECT * FROM batch_operations WHERE id=? AND tenant_id=?', [req.params.id, t]);
  if (!op) return res.status(404).json({ error: '批量操作不存在' });
  if (op.status !== 'previewed') return res.status(400).json({ error: '需先预览才能确认' });

  await repos.adapter.run('UPDATE batch_operations SET status=? WHERE id=? AND tenant_id=?', ['confirmed', req.params.id, t]);
  await logAudit(req.user.id, 'batch_confirm', req.params.id, null, req.ip);
  res.json({ ok: true, message: '已确认，可执行批量操作' });
}));

router.post('/batch-operations/:id/execute', asyncH(async (req, res) => {
  const t = requireTenant();
  if (!ADMIN_ROLES.includes(req.user.role || 'member')) return res.status(403).json({ error: '仅管理员可执行' });
  const op = await repos.adapter.get('SELECT * FROM batch_operations WHERE id=? AND tenant_id=?', [req.params.id, t]);
  if (!op) return res.status(404).json({ error: '批量操作不存在' });
  if (op.status !== 'confirmed') return res.status(400).json({ error: '需先确认才能执行' });

  const result = await executeBatch(Number(req.params.id));
  await logAudit(req.user.id, 'batch_execute', req.params.id, result, req.ip);
  res.json({ message: `执行完成: 成功 ${result.successCount}, 失败 ${result.failedCount}, 共 ${result.totalItems} 项`, ...result });
}));

router.post('/batch-operations/:id/cancel', asyncH(async (req, res) => {
  const t = requireTenant();
  if (!ADMIN_ROLES.includes(req.user.role || 'member')) return res.status(403).json({ error: '仅管理员可取消' });
  const op = await repos.adapter.get('SELECT * FROM batch_operations WHERE id=? AND tenant_id=?', [req.params.id, t]);
  if (!op) return res.status(404).json({ error: '批量操作不存在' });
  if (['running', 'completed', 'failed', 'partial'].includes(op.status))
    return res.status(400).json({ error: '当前状态不可取消' });
  await repos.adapter.run('UPDATE batch_operations SET status=? WHERE id=? AND tenant_id=?', ['cancelled', req.params.id, t]);
  await logAudit(req.user.id, 'batch_cancel', req.params.id, null, req.ip);
  res.json({ ok: true });
}));

router.delete('/batch-operations/:id', asyncH(async (req, res) => {
  const t = requireTenant();
  if (!ADMIN_ROLES.includes(req.user.role || 'member')) return res.status(403).json({ error: '仅管理员可删除' });
  await repos.adapter.run('DELETE FROM batch_operations WHERE id=? AND tenant_id=?', [req.params.id, t]);
  await logAudit(req.user.id, 'batch_delete', req.params.id, null, req.ip);
  res.json({ ok: true });
}));

router.get('/batch-operations/stats', asyncH(async (req, res) => {
  const t = requireTenant();
  const total = Number((await repos.adapter.get('SELECT COUNT(*) as c FROM batch_operations WHERE tenant_id=?', [t])).c);
  const draft = Number((await repos.adapter.get("SELECT COUNT(*) as c FROM batch_operations WHERE tenant_id=? AND status='draft'", [t])).c);
  const running = Number((await repos.adapter.get("SELECT COUNT(*) as c FROM batch_operations WHERE tenant_id=? AND status='running'", [t])).c);
  const completed = Number((await repos.adapter.get("SELECT COUNT(*) as c FROM batch_operations WHERE tenant_id=? AND status IN ('completed','partial')", [t])).c);
  const todayExecuted = Number((await repos.adapter.get('SELECT COUNT(*) as c FROM batch_operations WHERE tenant_id=? AND executed_at LIKE ?', [t, dayPrefix(todayLocal())])).c);
  const byAction = await repos.adapter.all('SELECT action_type, COUNT(*) as c FROM batch_operations WHERE tenant_id=? GROUP BY action_type ORDER BY c DESC', [t]);
  res.json({ total, draft, running, completed, today_executed: todayExecuted, by_action: byAction });
}));

module.exports = router;
