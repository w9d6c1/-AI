// ===== 超管后台：租户运营 / 跨租户视图 / 代登录 =====
// 仅 superadmin（平台上下文）可访问；所有操作写审计。
const express = require('express');
const bcrypt = require('bcryptjs');
const { repos } = require('../repositories');
const { nowExpr } = require('../repositories/sql');
const { runWithTenant } = require('../repositories/tenant-context');
const { authRequired, asyncH, requireRole, signImpersonation } = require('../middleware');
const { todayLocal, dateLocalOffset } = require('../util');

const router = express.Router();
router.use(authRequired);
router.use(requireRole('superadmin'));

async function audit(tenantId, adminId, action, targetType, targetId, detail) {
  await repos.adapter.run(
    'INSERT INTO audit_logs (tenant_id,user_id,action,target_type,target_id,detail_json) VALUES (?,?,?,?,?,?)',
    [tenantId, adminId, action, targetType, targetId ? String(targetId) : null, detail ? JSON.stringify(detail) : null]
  );
}

// ========== 租户管理 ==========
router.get('/tenants', asyncH(async (req, res) => {
  const tenants = await repos.adapter.all('SELECT * FROM tenants ORDER BY id');
  res.json({ tenants });
}));

router.post('/tenants', asyncH(async (req, res) => {
  const { name, slug, plan, max_shops, max_ai_calls_per_month } = req.body || {};
  if (!name) return res.status(400).json({ error: '租户名称不能为空' });
  if (slug) {
    const dup = await repos.adapter.get('SELECT id FROM tenants WHERE slug=?', [slug]);
    if (dup) return res.status(409).json({ error: 'slug 已存在' });
  }
  const info = await repos.adapter.run(
    'INSERT INTO tenants (name, slug, status, plan, max_shops, max_ai_calls_per_month) VALUES (?,?,?,?,?,?)',
    [name, slug || null, 'active', plan || 'trial', max_shops ?? 50, max_ai_calls_per_month ?? 100000]
  );
  await audit(info.lastInsertRowid, req.user.id, 'tenant_create', 'tenant', info.lastInsertRowid, { name });
  res.status(201).json({ tenant: await repos.adapter.get('SELECT * FROM tenants WHERE id=?', [info.lastInsertRowid]) });
}));

router.patch('/tenants/:id', asyncH(async (req, res) => {
  const tenant = await repos.adapter.get('SELECT * FROM tenants WHERE id=?', [req.params.id]);
  if (!tenant) return res.status(404).json({ error: '租户不存在' });
  const { status, plan, max_shops, max_ai_calls_per_month } = req.body || {};
  if (status && !['active', 'suspended'].includes(status)) return res.status(400).json({ error: '无效状态' });
  const now = nowExpr(repos.adapter.dialect);
  await repos.adapter.run(
    `UPDATE tenants SET status=?, plan=?, max_shops=?, max_ai_calls_per_month=?, updated_at=${now} WHERE id=?`,
    [status ?? tenant.status, plan ?? tenant.plan, max_shops ?? tenant.max_shops, max_ai_calls_per_month ?? tenant.max_ai_calls_per_month, tenant.id]
  );
  await audit(tenant.id, req.user.id, 'tenant_update', 'tenant', tenant.id, { status, plan, max_shops, max_ai_calls_per_month });
  res.json({ tenant: await repos.adapter.get('SELECT * FROM tenants WHERE id=?', [tenant.id]) });
}));

// 为租户创建初始用户（管理员/成员）
router.post('/tenants/:id/users', asyncH(async (req, res) => {
  const tenantId = Number(req.params.id);
  const tenant = await repos.adapter.get('SELECT * FROM tenants WHERE id=?', [tenantId]);
  if (!tenant) return res.status(404).json({ error: '租户不存在' });
  const { username, email, password, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (String(password).length < 12) return res.status(400).json({ error: '密码长度至少 12 位' });
  const allowRoles = ['member', 'admin', 'boss'];
  if (role !== undefined && !allowRoles.includes(role)) return res.status(400).json({ error: '无效角色' });
  const exists = await repos.users.existsByUsernameOrEmail(username, email);
  if (exists) return res.status(409).json({ error: '用户名或邮箱已存在' });

  const hash = bcrypt.hashSync(String(password), 10);
  const uid = await runWithTenant(tenantId, () => repos.tx(async () => {
    const teamId = await repos.teams.create(`${username}的团队`, null);
    const id = await repos.users.create({ username: String(username), email: email || null, passwordHash: hash, teamId, role: role || 'member', tenantId });
    await repos.teams.setOwner(teamId, id);
    return id;
  }));
  await audit(tenantId, req.user.id, 'tenant_user_create', 'user', uid, { username, role: role || 'member' });
  res.status(201).json({ id: uid, username, role: role || 'member', tenant_id: tenantId });
}));

// ========== 跨租户只读视图 ==========
router.get('/tenants/:id/overview', asyncH(async (req, res) => {
  const tenantId = Number(req.params.id);
  const tenant = await repos.adapter.get('SELECT * FROM tenants WHERE id=?', [tenantId]);
  if (!tenant) return res.status(404).json({ error: '租户不存在' });
  const weekAgo = dateLocalOffset(-7);
  const today = todayLocal();

  const users = Number((await repos.adapter.get('SELECT COUNT(*) AS c FROM users WHERE tenant_id=?', [tenantId])).c);
  const shops = Number((await repos.adapter.get('SELECT COUNT(*) AS c FROM shops WHERE tenant_id=?', [tenantId])).c);
  const suggestionsPending = Number((await repos.adapter.get("SELECT COUNT(*) AS c FROM suggestions WHERE tenant_id=? AND status='pending'", [tenantId])).c);
  const pay7d = Number((await repos.adapter.get('SELECT COALESCE(SUM(pay_amount),0) AS s FROM daily_reports WHERE tenant_id=? AND report_date>=?', [tenantId, weekAgo])).s);
  const alertsToday = Number((await repos.adapter.get('SELECT COUNT(*) AS c FROM alerts WHERE tenant_id=? AND triggered_at LIKE ?', [tenantId, today + '%'])).c);

  res.json({
    tenant,
    metrics: { users, shops, suggestions_pending: suggestionsPending, pay_7d: pay7d, alerts_today: alertsToday }
  });
}));

router.get('/tenants/:id/audit-logs', asyncH(async (req, res) => {
  const limit = Math.min(200, Number(req.query.limit) || 50);
  const logs = await repos.adapter.all('SELECT * FROM audit_logs WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?', [Number(req.params.id), limit]);
  res.json({ logs });
}));

// ========== 代登录（只读，15 分钟）==========
router.post('/users/:id/impersonate', asyncH(async (req, res) => {
  const target = await repos.adapter.get('SELECT id, username, role, tenant_id, session_version FROM users WHERE id=?', [req.params.id]);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  if (target.role === 'superadmin') return res.status(400).json({ error: '不可代登录超管账号' });
  const tenant = await repos.adapter.get('SELECT id, status FROM tenants WHERE id=?', [target.tenant_id]);
  if (!tenant || tenant.status !== 'active') return res.status(400).json({ error: '目标租户不可用' });

  const token = await signImpersonation(req.user.id, target);
  await audit(target.tenant_id, req.user.id, 'impersonate', 'user', target.id, { username: target.username, tenant_id: target.tenant_id });
  res.json({ token, expires_in: 900, tenant_id: target.tenant_id, user: { id: target.id, username: target.username } });
}));

module.exports = router;
