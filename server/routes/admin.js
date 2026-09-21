// ===== 超管后台：租户运营 / 跨租户视图 / 代登录 =====
// 仅 superadmin（平台上下文）可访问；所有操作写审计。
const express = require('express');
const bcrypt = require('bcryptjs');
const { repos } = require('../repositories');
const { nowExpr } = require('../repositories/sql');
const { runWithTenant } = require('../repositories/tenant-context');
const { authRequired, asyncH, requireRole, signImpersonation } = require('../middleware');
const { todayLocal, dateLocalOffset } = require('../util');
const { getTenantUsage, getTenantLimits, quotaAlerts, monthKey } = require('../quota');

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
  const { name, slug, plan, max_shops, max_ai_calls_per_month, max_tokens_per_month, billing_cycle, price_per_month, max_cost_per_month, trial_ends_at, contact_name, contact_email } = req.body || {};
  if (!name) return res.status(400).json({ error: '租户名称不能为空' });
  if (slug) {
    const dup = await repos.adapter.get('SELECT id FROM tenants WHERE slug=?', [slug]);
    if (dup) return res.status(409).json({ error: 'slug 已存在' });
  }
  const info = await repos.adapter.run(
    `INSERT INTO tenants (name, slug, status, plan, max_shops, max_ai_calls_per_month, max_tokens_per_month, billing_cycle, price_per_month, max_cost_per_month, trial_ends_at, contact_name, contact_email)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [name, slug || null, 'active', plan || 'trial', max_shops ?? 50, max_ai_calls_per_month ?? 100000, Number(max_tokens_per_month) || 0,
      billing_cycle || 'monthly', Number(price_per_month) || 0, Number(max_cost_per_month) || 0,
      trial_ends_at || null, contact_name || null, contact_email || null]
  );
  await audit(info.lastInsertRowid, req.user.id, 'tenant_create', 'tenant', info.lastInsertRowid, { name });
  res.status(201).json({ tenant: await repos.adapter.get('SELECT * FROM tenants WHERE id=?', [info.lastInsertRowid]) });
}));

router.patch('/tenants/:id', asyncH(async (req, res) => {
  const tenant = await repos.adapter.get('SELECT * FROM tenants WHERE id=?', [req.params.id]);
  if (!tenant) return res.status(404).json({ error: '租户不存在' });
  const b = req.body || {};
  if (b.status && !['active', 'suspended'].includes(b.status)) return res.status(400).json({ error: '无效状态' });
  const now = nowExpr(repos.adapter.dialect);
  const pick = (k, fallback) => (b[k] !== undefined ? b[k] : fallback);
  const next = {
    status: pick('status', tenant.status),
    plan: pick('plan', tenant.plan),
    max_shops: pick('max_shops', tenant.max_shops),
    max_ai_calls_per_month: pick('max_ai_calls_per_month', tenant.max_ai_calls_per_month),
    max_tokens_per_month: Number(pick('max_tokens_per_month', tenant.max_tokens_per_month)) || 0,
    billing_cycle: pick('billing_cycle', tenant.billing_cycle),
    price_per_month: Number(pick('price_per_month', tenant.price_per_month)) || 0,
    max_cost_per_month: Number(pick('max_cost_per_month', tenant.max_cost_per_month)) || 0,
    trial_ends_at: pick('trial_ends_at', tenant.trial_ends_at) || null,
    contact_name: pick('contact_name', tenant.contact_name) || null,
    contact_email: pick('contact_email', tenant.contact_email) || null
  };
  await repos.adapter.run(
    `UPDATE tenants SET status=?, plan=?, max_shops=?, max_ai_calls_per_month=?, max_tokens_per_month=?, billing_cycle=?, price_per_month=?, max_cost_per_month=?, trial_ends_at=?, contact_name=?, contact_email=?, updated_at=${now} WHERE id=?`,
    [next.status, next.plan, next.max_shops, next.max_ai_calls_per_month, next.max_tokens_per_month, next.billing_cycle, next.price_per_month, next.max_cost_per_month, next.trial_ends_at, next.contact_name, next.contact_email, tenant.id]
  );
  await audit(tenant.id, req.user.id, 'tenant_update', 'tenant', tenant.id, next);
  res.json({ tenant: await repos.adapter.get('SELECT * FROM tenants WHERE id=?', [tenant.id]) });
}));

// 平台总览：租户/店铺/用户规模 + 当月 AI 用量 + MRR（按活跃租户月费估算）
router.get('/overview', asyncH(async (req, res) => {
  const tenants = await repos.adapter.all('SELECT id, status, plan, price_per_month FROM tenants');
  const totalShops = Number((await repos.adapter.get('SELECT COUNT(*) AS c FROM shops')).c);
  const totalUsers = Number((await repos.adapter.get('SELECT COUNT(*) AS c FROM users')).c);
  const month = monthKey();
  const usage = (await repos.adapter.get('SELECT COUNT(*) AS calls, COALESCE(SUM(cost),0) AS cost FROM ai_usage WHERE created_at LIKE ?', [month + '%'])) || {};
  const active = tenants.filter(t => t.status === 'active');
  const mrr = active.reduce((s, t) => s + (Number(t.price_per_month) || 0), 0);
  res.json({
    tenants: { total: tenants.length, active: active.length, suspended: tenants.length - active.length },
    shops: totalShops,
    users: totalUsers,
    month,
    ai: { calls: Number(usage.calls || 0), cost: Math.round(Number(usage.cost || 0) * 10000) / 10000 },
    mrr: Math.round(mrr * 100) / 100
  });
}));

// 租户用量与计费：当月 AI 调用/tokens/成本 + 配额使用 + 计费信息
router.get('/tenants/:id/usage', asyncH(async (req, res) => {
  const tenantId = Number(req.params.id);
  const tenant = await repos.adapter.get('SELECT * FROM tenants WHERE id=?', [tenantId]);
  if (!tenant) return res.status(404).json({ error: '租户不存在' });
  const month = req.query.month || monthKey();
  const usage = await getTenantUsage(tenantId, month);
  const limits = await getTenantLimits(tenantId);
  const shops = Number((await repos.adapter.get('SELECT COUNT(*) AS c FROM shops WHERE tenant_id=?', [tenantId])).c);
  const usedTokens = usage.ai.tokens_in + usage.ai.tokens_out;
  const alerts = quotaAlerts([
    { key: 'shops', label: '店铺数', used: shops, max: limits.maxShops },
    { key: 'ai_calls', label: 'AI 调用', used: usage.ai.calls, max: limits.maxAiCalls },
    { key: 'ai_tokens', label: 'AI tokens', used: usedTokens, max: limits.maxTokens },
    { key: 'ai_cost', label: 'AI 成本', used: usage.ai.cost, max: limits.maxCost }
  ]);
  res.json({
    tenant_id: tenantId,
    month,
    usage,
    limits: { max_shops: limits.maxShops, max_ai_calls_per_month: limits.maxAiCalls, max_tokens_per_month: limits.maxTokens, max_cost_per_month: limits.maxCost },
    used: { shops, ai_calls: usage.ai.calls, ai_tokens: usedTokens, ai_cost: usage.ai.cost },
    alerts,
    billing: { cycle: tenant.billing_cycle, price_per_month: Number(tenant.price_per_month) || 0, trial_ends_at: tenant.trial_ends_at || null }
  });
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

// 租户用户列表（供超管代登录）
router.get('/tenants/:id/users', asyncH(async (req, res) => {
  const tenantId = Number(req.params.id);
  const tenant = await repos.adapter.get('SELECT id FROM tenants WHERE id=?', [tenantId]);
  if (!tenant) return res.status(404).json({ error: '租户不存在' });
  const users = await repos.adapter.all('SELECT id, username, email, role, created_at FROM users WHERE tenant_id=? ORDER BY id', [tenantId]);
  res.json({ users });
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

// ========== AI Provider 热更新（§4）==========
// 运行期重载 provider 配置（不重启）；可写入内存配置或从环境变量重载。
router.get('/ai/providers', asyncH(async (req, res) => {
  const registry = require('../integrations/registry');
  res.json({ providers: registry.describe() });
}));

router.put('/ai/providers', asyncH(async (req, res) => {
  const { providers } = req.body || {};
  if (!Array.isArray(providers) || !providers.length) return res.status(400).json({ error: 'providers 须为非空数组' });
  for (const p of providers) {
    if (!p || typeof p !== 'object' || !p.id || !Array.isArray(p.caps) || !p.caps.length) {
      return res.status(400).json({ error: '每个 provider 需包含 id 与 caps' });
    }
  }
  process.env.AI_PROVIDERS = JSON.stringify(providers);
  const registry = require('../integrations/registry');
  registry.reloadProviders();
  await audit(1, req.user.id, 'ai_providers_update', 'ai_provider', null, { count: providers.length });
  res.json({ providers: registry.describe() });
}));

router.post('/ai/providers/reload', asyncH(async (req, res) => {
  const registry = require('../integrations/registry');
  registry.reloadProviders();
  await audit(1, req.user.id, 'ai_providers_reload', 'ai_provider', null, null);
  res.json({ providers: registry.describe() });
}));

// ========== 全局审计查询（跨租户）==========
router.get('/audit-logs', asyncH(async (req, res) => {
  const limit = Math.min(500, Number(req.query.limit) || 100);
  const params = [];
  const where = [];
  if (req.query.tenant_id) { where.push('tenant_id=?'); params.push(Number(req.query.tenant_id)); }
  if (req.query.user_id) { where.push('user_id=?'); params.push(Number(req.query.user_id)); }
  if (req.query.action) { where.push('action=?'); params.push(req.query.action); }
  if (req.query.date_start) { where.push('created_at >= ?'); params.push(req.query.date_start); }
  if (req.query.date_end) { where.push('created_at <= ?'); params.push(req.query.date_end + ' 23:59:59'); }
  const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const logs = await repos.adapter.all(`SELECT * FROM audit_logs${clause} ORDER BY id DESC LIMIT ?`, [...params, limit]);
  res.json({ logs, limit });
}));

// ========== 数据保留策略 ==========
router.get('/retention/policy', (req, res) => {
  const { POLICIES, policyDays } = require('../retention');
  res.json({ policies: POLICIES.map(p => ({ table: p.table, column: p.column, days: policyDays(p), env: p.env })) });
});

router.post('/retention/run', asyncH(async (req, res) => {
  const { runRetention } = require('../retention');
  const summary = await runRetention();
  await audit(1, req.user.id, 'retention_run', 'retention', null, { tenants: Object.keys(summary).length });
  res.json({ summary });
}));

module.exports = router;
