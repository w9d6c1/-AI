// ===== 预警通知路由 =====
const express = require('express');
const { repos } = require('../repositories');
const { requireTenant } = require('../repositories/tenant-context');
const { dayPrefix } = require('../repositories/sql');
const { authRequired, asyncH, requireRole } = require('../middleware');
const { runAlertChecks } = require('../alert');
const { resendNotifications, sendNotifications } = require('../notifier');
const { todayLocal } = require('../util');

const router = express.Router();
router.use(authRequired);
// 内部试用阶段：全局预警及通知设置仅向管理员开放。
router.use(['/alerts', '/alert-rules', '/notification-channels'], requireRole('boss', 'admin'));

const ADMIN_ROLES = ['boss', 'admin'];

async function logAudit(userId, action, targetId, detail, ip) {
  const t = requireTenant();
  await repos.adapter.run(
    'INSERT INTO audit_logs (user_id, action, target_type, target_id, detail_json, ip_address, tenant_id) VALUES (?,?,?,?,?,?,?)',
    [userId || null, action, 'alert', targetId ? String(targetId) : null, detail ? JSON.stringify(detail) : null, ip || null, t]
  );
}

// ========== 预警规则管理 ==========
router.get('/alert-rules', asyncH(async (req, res) => {
  const t = requireTenant();
  const rules = await repos.adapter.all('SELECT * FROM alert_rules WHERE tenant_id=? ORDER BY id', [t]);
  res.json({
    rules: rules.map(r => ({
      ...r,
      conditions: r.conditions ? JSON.parse(r.conditions) : {},
      target_ids: r.target_ids ? JSON.parse(r.target_ids) : [],
      enabled: !!r.enabled
    }))
  });
}));

router.post('/alert-rules', asyncH(async (req, res) => {
  if (!ADMIN_ROLES.includes(req.user.role || 'member')) return res.status(403).json({ error: '仅管理员可创建预警规则' });
  const t = requireTenant();
  const { name, rule_type, conditions, severity, target_type, target_ids, cooldown_hours } = req.body;
  if (!name || !rule_type) return res.status(400).json({ error: '名称和规则类型不能为空' });
  const validTypes = ['burn', 'roi_drop', 'cost_overrun', 'conv_drop'];
  if (!validTypes.includes(rule_type)) return res.status(400).json({ error: `规则类型须为: ${validTypes.join(', ')}` });

  const now = new Date().toLocaleString('zh-CN');
  const info = await repos.adapter.run(
    'INSERT INTO alert_rules (name, rule_type, conditions, severity, target_type, target_ids, enabled, cooldown_hours, created_at, updated_at, tenant_id) VALUES (?,?,?,?,?,?,1,?,?,?,?)',
    [name, rule_type, JSON.stringify(conditions || {}), severity || 'warning', target_type || 'all', target_ids ? JSON.stringify(target_ids) : null, cooldown_hours ?? 6, now, now, t]
  );
  await logAudit(req.user.id, 'alert_rule_create', info.lastInsertRowid, { name, rule_type }, req.ip);
  res.json({ rule: await repos.adapter.get('SELECT * FROM alert_rules WHERE id=? AND tenant_id=?', [info.lastInsertRowid, t]) });
}));

router.put('/alert-rules/:id', asyncH(async (req, res) => {
  if (!ADMIN_ROLES.includes(req.user.role || 'member')) return res.status(403).json({ error: '仅管理员可修改规则' });
  const t = requireTenant();
  const r = await repos.adapter.get('SELECT * FROM alert_rules WHERE id=? AND tenant_id=?', [req.params.id, t]);
  if (!r) return res.status(404).json({ error: '规则不存在' });
  const { name, rule_type, conditions, severity, target_type, target_ids, cooldown_hours } = req.body;
  const now = new Date().toLocaleString('zh-CN');
  await repos.adapter.run(
    'UPDATE alert_rules SET name=?, rule_type=?, conditions=?, severity=?, target_type=?, target_ids=?, cooldown_hours=?, updated_at=? WHERE id=? AND tenant_id=?',
    [name ?? r.name, rule_type ?? r.rule_type,
      conditions !== undefined ? JSON.stringify(conditions) : r.conditions,
      severity ?? r.severity, target_type ?? r.target_type,
      target_ids !== undefined ? (target_ids ? JSON.stringify(target_ids) : null) : r.target_ids,
      cooldown_hours ?? r.cooldown_hours, now, req.params.id, t]
  );
  await logAudit(req.user.id, 'alert_rule_update', req.params.id, { name }, req.ip);
  res.json({ rule: await repos.adapter.get('SELECT * FROM alert_rules WHERE id=? AND tenant_id=?', [req.params.id, t]) });
}));

router.patch('/alert-rules/:id/toggle', asyncH(async (req, res) => {
  if (!ADMIN_ROLES.includes(req.user.role || 'member')) return res.status(403).json({ error: '仅管理员可操作' });
  const t = requireTenant();
  const r = await repos.adapter.get('SELECT * FROM alert_rules WHERE id=? AND tenant_id=?', [req.params.id, t]);
  if (!r) return res.status(404).json({ error: '规则不存在' });
  await repos.adapter.run('UPDATE alert_rules SET enabled=?, updated_at=? WHERE id=? AND tenant_id=?', [r.enabled ? 0 : 1, new Date().toLocaleString('zh-CN'), req.params.id, t]);
  res.json({ ok: true, enabled: !r.enabled });
}));

router.delete('/alert-rules/:id', asyncH(async (req, res) => {
  if (!ADMIN_ROLES.includes(req.user.role || 'member')) return res.status(403).json({ error: '仅管理员可删除规则' });
  const t = requireTenant();
  await repos.adapter.run('DELETE FROM alert_rules WHERE id=? AND tenant_id=?', [req.params.id, t]);
  await logAudit(req.user.id, 'alert_rule_delete', req.params.id, null, req.ip);
  res.json({ ok: true });
}));

// ========== 预警记录 ==========
router.get('/alerts', asyncH(async (req, res) => {
  const t = requireTenant();
  const limit = Math.min(200, Number(req.query.limit) || 50);
  let query = `SELECT a.*, s.shop_name FROM alerts a LEFT JOIN shops s ON a.shop_id=s.id AND s.tenant_id = a.tenant_id`;
  const conditions = ['a.tenant_id=?'], params = [t];
  if (req.query.severity) { conditions.push('a.severity=?'); params.push(req.query.severity); }
  if (req.query.status) { conditions.push('a.status=?'); params.push(req.query.status); }
  if (req.query.shop_id) { conditions.push('a.shop_id=?'); params.push(Number(req.query.shop_id)); }
  if (req.query.alert_type) { conditions.push('a.alert_type=?'); params.push(req.query.alert_type); }
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY a.triggered_at DESC LIMIT ?';
  const alerts = await repos.adapter.all(query, [...params, limit]);
  res.json({
    alerts: alerts.map(a => ({ ...a, metrics_json: a.metrics_json ? JSON.parse(a.metrics_json) : null }))
  });
}));

router.get('/alerts/stats', asyncH(async (req, res) => {
  const t = requireTenant();
  const total = Number((await repos.adapter.get('SELECT COUNT(*) as c FROM alerts WHERE tenant_id=?', [t])).c);
  const unread = Number((await repos.adapter.get('SELECT COUNT(*) as c FROM alerts WHERE status=? AND tenant_id=?', ['unread', t])).c);
  const critical = Number((await repos.adapter.get('SELECT COUNT(*) as c FROM alerts WHERE severity=\'critical\' AND status=\'unread\' AND tenant_id=?', [t])).c);
  const todayCount = Number((await repos.adapter.get('SELECT COUNT(*) as c FROM alerts WHERE triggered_at LIKE ? AND tenant_id=?', [dayPrefix(todayLocal()), t])).c);
  const byType = await repos.adapter.all('SELECT alert_type, COUNT(*) as c FROM alerts WHERE tenant_id=? GROUP BY alert_type ORDER BY c DESC', [t]);
  const bySeverity = await repos.adapter.all('SELECT severity, COUNT(*) as c FROM alerts WHERE tenant_id=? GROUP BY severity', [t]);
  res.json({ total, unread, critical, today: todayCount, by_type: byType, by_severity: bySeverity });
}));

router.patch('/alerts/:id/acknowledge', asyncH(async (req, res) => {
  const t = requireTenant();
  const a = await repos.adapter.get('SELECT * FROM alerts WHERE id=? AND tenant_id=?', [req.params.id, t]);
  if (!a) return res.status(404).json({ error: '预警不存在' });
  await repos.adapter.run('UPDATE alerts SET status=?, acknowledged_at=?, acknowledged_by=? WHERE id=? AND tenant_id=?',
    ['acknowledged', new Date().toLocaleString('zh-CN'), req.user.id, req.params.id, t]);
  await logAudit(req.user.id, 'alert_ack', req.params.id, null, req.ip);
  res.json({ ok: true });
}));

router.post('/alerts/batch-acknowledge', asyncH(async (req, res) => {
  const { ids } = req.body;
  if (!ids || !ids.length) return res.status(400).json({ error: '请选择预警' });
  const t = requireTenant();
  const now = new Date().toLocaleString('zh-CN');
  for (const id of ids) {
    await repos.adapter.run('UPDATE alerts SET status=?, acknowledged_at=?, acknowledged_by=? WHERE id=? AND tenant_id=?', ['acknowledged', now, req.user.id, id, t]);
  }
  res.json({ ok: true, count: ids.length });
}));

router.post('/alerts/check', asyncH(async (req, res) => {
  if (!ADMIN_ROLES.includes(req.user.role || 'member')) return res.status(403).json({ error: '仅管理员可触发检测' });
  const targetDate = req.query.date || todayLocal();
  const results = await runAlertChecks(targetDate);
  await logAudit(req.user.id, 'alert_check', null, { date: targetDate, found: results.length }, req.ip);
  res.json({ message: `检测完成，发现 ${results.length} 条预警`, count: results.length, alerts: results });
}));

router.post('/alerts/:id/resend', asyncH(async (req, res) => {
  if (!ADMIN_ROLES.includes(req.user.role || 'member')) return res.status(403).json({ error: '仅管理员可重发通知' });
  const t = requireTenant();
  const alert = await repos.adapter.get('SELECT id FROM alerts WHERE id=? AND tenant_id=?', [req.params.id, t]);
  if (!alert) return res.status(404).json({ error: '预警不存在' });
  await resendNotifications(Number(req.params.id));
  const notifs = await repos.adapter.all('SELECT n.*, nc.name as channel_name FROM notifications n JOIN notification_channels nc ON n.channel_id=nc.id AND nc.tenant_id = n.tenant_id WHERE n.alert_id=? AND n.tenant_id=?', [req.params.id, t]);
  res.json({ message: '通知已重发', notifications: notifs });
}));

router.get('/alerts/:id/notifications', asyncH(async (req, res) => {
  const t = requireTenant();
  const notifs = await repos.adapter.all('SELECT n.*, nc.name as channel_name, nc.channel_type FROM notifications n JOIN notification_channels nc ON n.channel_id=nc.id AND nc.tenant_id = n.tenant_id WHERE n.alert_id=? AND n.tenant_id=? ORDER BY n.sent_at DESC', [req.params.id, t]);
  res.json({ notifications: notifs });
}));

// ========== 通知渠道管理 ==========
router.get('/notification-channels', asyncH(async (req, res) => {
  const t = requireTenant();
  const channels = await repos.adapter.all('SELECT * FROM notification_channels WHERE tenant_id=? ORDER BY id', [t]);
  res.json({ channels: channels.map(c => ({ ...c, enabled: !!c.enabled })) });
}));

router.post('/notification-channels', asyncH(async (req, res) => {
  if (!ADMIN_ROLES.includes(req.user.role || 'member')) return res.status(403).json({ error: '仅管理员可配置通知渠道' });
  const { name, channel_type, webhook_url, email_to } = req.body;
  if (!name || !channel_type) return res.status(400).json({ error: '名称和渠道类型不能为空' });
  const t = requireTenant();
  const validTypes = ['dingtalk', 'wecom', 'feishu', 'email', 'webhook'];
  if (!validTypes.includes(channel_type)) return res.status(400).json({ error: `渠道类型须为: ${validTypes.join(', ')}` });
  if (channel_type !== 'email' && !webhook_url) return res.status(400).json({ error: '非邮件渠道需提供 Webhook URL' });
  if (channel_type === 'email' && !email_to) return res.status(400).json({ error: '邮件渠道需提供收件地址' });

  const info = await repos.adapter.run('INSERT INTO notification_channels (name, channel_type, webhook_url, email_to, enabled, tenant_id) VALUES (?,?,?,?,1,?)', [name, channel_type, webhook_url || null, email_to || null, t]);
  await logAudit(req.user.id, 'channel_create', info.lastInsertRowid, { name, channel_type }, req.ip);
  res.json({ channel: await repos.adapter.get('SELECT * FROM notification_channels WHERE id=? AND tenant_id=?', [info.lastInsertRowid, t]) });
}));

router.put('/notification-channels/:id', asyncH(async (req, res) => {
  if (!ADMIN_ROLES.includes(req.user.role || 'member')) return res.status(403).json({ error: '仅管理员可修改渠道' });
  const t = requireTenant();
  const c = await repos.adapter.get('SELECT * FROM notification_channels WHERE id=? AND tenant_id=?', [req.params.id, t]);
  if (!c) return res.status(404).json({ error: '渠道不存在' });
  const { name, webhook_url, email_to } = req.body;
  await repos.adapter.run('UPDATE notification_channels SET name=?, webhook_url=?, email_to=? WHERE id=? AND tenant_id=?',
    [name ?? c.name, webhook_url ?? c.webhook_url, email_to ?? c.email_to, req.params.id, t]);
  res.json({ channel: await repos.adapter.get('SELECT * FROM notification_channels WHERE id=? AND tenant_id=?', [req.params.id, t]) });
}));

router.patch('/notification-channels/:id/toggle', asyncH(async (req, res) => {
  if (!ADMIN_ROLES.includes(req.user.role || 'member')) return res.status(403).json({ error: '仅管理员可操作' });
  const t = requireTenant();
  const c = await repos.adapter.get('SELECT * FROM notification_channels WHERE id=? AND tenant_id=?', [req.params.id, t]);
  if (!c) return res.status(404).json({ error: '渠道不存在' });
  await repos.adapter.run('UPDATE notification_channels SET enabled=? WHERE id=? AND tenant_id=?', [c.enabled ? 0 : 1, req.params.id, t]);
  res.json({ ok: true, enabled: !c.enabled });
}));

router.delete('/notification-channels/:id', asyncH(async (req, res) => {
  if (!ADMIN_ROLES.includes(req.user.role || 'member')) return res.status(403).json({ error: '仅管理员可删除渠道' });
  const t = requireTenant();
  await repos.adapter.run('DELETE FROM notification_channels WHERE id=? AND tenant_id=?', [req.params.id, t]);
  await logAudit(req.user.id, 'channel_delete', req.params.id, null, req.ip);
  res.json({ ok: true });
}));

router.post('/notification-channels/:id/test', asyncH(async (req, res) => {
  if (!ADMIN_ROLES.includes(req.user.role || 'member')) return res.status(403).json({ error: '仅管理员可测试渠道' });
  const t = requireTenant();
  const c = await repos.adapter.get('SELECT * FROM notification_channels WHERE id=? AND tenant_id=?', [req.params.id, t]);
  if (!c) return res.status(404).json({ error: '渠道不存在' });

  const info = await repos.adapter.run("INSERT INTO alerts (alert_type, severity, title, message, metrics_json, tenant_id) VALUES ('test','info','测试通知','这是一条来自预警系统的测试通知','{}',?)", [t]);
  await sendNotifications(info.lastInsertRowid);
  const notif = await repos.adapter.get('SELECT * FROM notifications WHERE alert_id=? AND tenant_id=?', [info.lastInsertRowid, t]);
  await repos.adapter.run('DELETE FROM alerts WHERE id=? AND tenant_id=?', [info.lastInsertRowid, t]);
  res.json({ ok: true, message: notif?.status === 'sent' ? '测试通知发送成功' : '测试通知发送失败', status: notif?.status, error: notif?.error_msg });
}));

module.exports = router;
