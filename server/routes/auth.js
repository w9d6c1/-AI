// ===== 认证路由：注册 / 登录 / 2FA / 密码策略 / 用户管理 =====
// 数据访问统一走仓储层（server/repositories）。
const express = require('express');
const { seedTasks } = require('../seed');
const { signToken, authRequired, requireRole, rateLimiter, asyncH } = require('../middleware');
const { repos } = require('../repositories');
const { nowLocal } = require('../util');
const { audit } = require('../audit');
const passwords = require('../security/passwords');
const lockout = require('../security/lockout');
const totp = require('../security/totp');

const router = express.Router();

// 用户管理仅限管理员
const adminOnly = [authRequired, requireRole('boss', 'admin')];

// 登录/注册接口更严格的限流（防暴力破解）
const authLimiter = rateLimiter(60000, 10, 'auth');
router.get('/config', (req, res) => res.json({ registration_enabled: process.env.ALLOW_REGISTRATION === 'true' }));

function clientMeta(req) {
  return { ip: req.ip, userAgent: req.headers['user-agent'] || null };
}

// 校验恢复码：命中则从存储中移除
function consumeRecoveryCode(user, code) {
  let list;
  try { list = JSON.parse(user.totp_recovery || '[]'); } catch (_) { list = []; }
  if (!Array.isArray(list) || !list.length) return null;
  const idx = list.findIndex(h => passwords.verify(code, h));
  if (idx === -1) return null;
  const rest = list.slice(0, idx).concat(list.slice(idx + 1));
  return rest;
}

// 注册
router.post('/register', authLimiter, asyncH(async (req, res) => {
  if (process.env.ALLOW_REGISTRATION !== 'true') return res.status(403).json({ error: '内部试用暂不开放注册，请联系管理员创建账号' });
  const { username, email, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (!/^[\w\u4e00-\u9fa5]{2,20}$/.test(String(username))) {
    return res.status(400).json({ error: '用户名需为 2-20 位字母/数字/中文/下划线' });
  }
  const v = passwords.validate(password, { username });
  if (!v.ok) return res.status(400).json({ error: v.errors.join('；') });
  const exists = await repos.users.existsByUsernameOrEmail(username, email);
  if (exists) return res.status(409).json({ error: '用户名或邮箱已被注册' });

  const hash = passwords.hash(password);
  const { runWithTenant } = require('../repositories/tenant-context');
  const { userId, teamId } = await runWithTenant(1, () => repos.tx(async () => {
    const tid = await repos.teams.create(`${username}的团队`, null);
    const uid = await repos.users.create({ username: String(username), email: email || null, passwordHash: hash, teamId: tid, tenantId: 1 });
    await repos.teams.setOwner(tid, uid);
    await seedTasks(uid);
    return { userId: uid, teamId: tid };
  }));
  await repos.users.update(userId, { password_changed_at: nowLocal() }, { platform: true });
  const user = await runWithTenant(1, () => repos.users.findByIdPublic(userId));
  res.json({ token: await signToken({ ...user, team_id: teamId }), user });
}));

// 登录（含账号锁定 + 2FA）
router.post('/login', authLimiter, asyncH(async (req, res) => {
  const { username, password, totp: code } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  const meta = clientMeta(req);
  const user = await repos.users.findByLogin(username);
  const generic = { error: '用户名或密码错误' };
  if (!user) {
    await audit({ tenantId: 1, action: 'login_failed', targetType: 'user', targetId: username, detail: { reason: 'not_found' }, ...meta });
    return res.status(401).json(generic);
  }
  if (lockout.isLocked(user)) {
    await audit({ tenantId: user.tenant_id, userId: user.id, action: 'login_locked', targetType: 'user', targetId: user.id, detail: { locked_until: user.locked_until }, ...meta });
    return res.status(423).json({ error: '账号已锁定，请稍后再试', locked_until: user.locked_until });
  }
  if (!passwords.verify(password, user.password_hash)) {
    const r = await lockout.registerFailure(user);
    await audit({ tenantId: user.tenant_id, userId: user.id, action: 'login_failed', targetType: 'user', targetId: user.id, detail: { count: r.count, locked: r.locked }, ...meta });
    if (r.locked) return res.status(423).json({ error: '失败次数过多，账号已锁定', locked_until: r.locked_until });
    return res.status(401).json(generic);
  }
  if (user.totp_enabled) {
    if (!code) return res.status(401).json({ error: '请输入两步验证码', requires_2fa: true });
    const okTotp = totp.verify(user.totp_secret, code);
    if (!okTotp) {
      const rest = consumeRecoveryCode(user, String(code));
      if (rest === null) {
        const r = await lockout.registerFailure(user);
        await audit({ tenantId: user.tenant_id, userId: user.id, action: 'login_2fa_failed', targetType: 'user', targetId: user.id, detail: { locked: r.locked }, ...meta });
        return res.status(401).json({ error: '验证码错误', requires_2fa: true });
      }
      await require('../repositories/tenant-context').runAsPlatform(() => repos.users.update(user.id, { totp_recovery: JSON.stringify(rest) }, { platform: true }));
      await audit({ tenantId: user.tenant_id, userId: user.id, action: 'login_2fa_recovery_used', targetType: 'user', targetId: user.id, detail: { remaining: rest.length }, ...meta });
    }
  }
  await lockout.reset(user.id);
  await audit({ tenantId: user.tenant_id, userId: user.id, action: 'login_success', targetType: 'user', targetId: user.id, ...meta });
  res.json({
    token: await signToken(user),
    user: { id: user.id, username: user.username, email: user.email, team_id: user.team_id, role: user.role },
    totp_enabled: !!user.totp_enabled
  });
}));

// 当前用户信息
router.get('/me', authRequired, asyncH(async (req, res) => {
  const user = await repos.users.findByIdPublic(req.user.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const team = user.team_id ? await repos.teams.findById(user.team_id) : null;
  res.json({ user: { ...user, team: team ? team.name : null } });
}));

// ===== 安全中心：2FA / 密码 =====
router.get('/security', authRequired, asyncH(async (req, res) => {
  const u = await repos.users.findSecurity(req.user.id, { tenantId: req.user.tenantId });
  if (!u) return res.status(404).json({ error: '用户不存在' });
  let recoveryRemaining = 0;
  try { recoveryRemaining = JSON.parse(u.totp_recovery || '[]').length; } catch (_) { /* ignore */ }
  res.json({
    totp_enabled: !!u.totp_enabled,
    recovery_codes_remaining: recoveryRemaining,
    password_changed_at: u.password_changed_at || null,
    must_change_password: !!u.must_change_password,
    locked_until: u.locked_until || null,
    password_policy: { min_length: passwords.minLength() }
  });
}));

// 生成 2FA 密钥与恢复码（待 verify 后启用）
router.post('/2fa/setup', authRequired, asyncH(async (req, res) => {
  const secret = totp.generateSecret();
  const codes = totp.generateRecoveryCodes(8);
  await repos.users.update(req.user.id, {
    totp_secret: secret,
    totp_enabled: 0,
    totp_recovery: JSON.stringify(codes.map(c => passwords.hash(c)))
  }, { tenantId: req.user.tenantId });
  await audit({ tenantId: req.user.tenantId, userId: req.user.id, action: '2fa_setup_started', targetType: 'user', targetId: req.user.id, ...clientMeta(req) });
  res.json({ secret, otpauth_url: totp.otpauthURL(secret, req.user.username), recovery_codes: codes });
}));

// 校验并启用 2FA
router.post('/2fa/verify', authRequired, asyncH(async (req, res) => {
  const { code } = req.body || {};
  const u = await repos.users.findSecurity(req.user.id, { tenantId: req.user.tenantId });
  if (!u || !u.totp_secret) return res.status(400).json({ error: '请先执行 2FA 初始化' });
  if (!totp.verify(u.totp_secret, code)) return res.status(400).json({ error: '验证码错误' });
  await repos.users.update(req.user.id, { totp_enabled: 1 }, { tenantId: req.user.tenantId });
  await audit({ tenantId: req.user.tenantId, userId: req.user.id, action: '2fa_enabled', targetType: 'user', targetId: req.user.id, ...clientMeta(req) });
  res.json({ enabled: true });
}));

// 关闭 2FA（需密码 + 验证码/恢复码）
router.post('/2fa/disable', authRequired, asyncH(async (req, res) => {
  const { password, code } = req.body || {};
  const u = await repos.users.findSecurity(req.user.id, { tenantId: req.user.tenantId });
  if (!u || !u.totp_enabled) return res.status(400).json({ error: '未启用两步验证' });
  if (!passwords.verify(password, u.password_hash)) return res.status(400).json({ error: '密码错误' });
  const ok = totp.verify(u.totp_secret, code) || consumeRecoveryCode(u, String(code)) !== null;
  if (!ok) return res.status(400).json({ error: '验证码错误' });
  await repos.users.update(req.user.id, { totp_enabled: 0, totp_secret: null, totp_recovery: null }, { tenantId: req.user.tenantId });
  await audit({ tenantId: req.user.tenantId, userId: req.user.id, action: '2fa_disabled', targetType: 'user', targetId: req.user.id, ...clientMeta(req) });
  res.json({ enabled: false });
}));

// 修改密码（策略 + 历史复用校验）
router.post('/password', authRequired, asyncH(async (req, res) => {
  const { current_password, new_password } = req.body || {};
  const u = await repos.users.findSecurity(req.user.id, { tenantId: req.user.tenantId });
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (!passwords.verify(current_password, u.password_hash)) return res.status(400).json({ error: '当前密码错误' });
  const v = passwords.validate(new_password, { username: req.user.username });
  if (!v.ok) return res.status(400).json({ error: v.errors.join('；') });
  if (passwords.reused(new_password, u.password_history)) return res.status(400).json({ error: '不能复用最近使用过的密码' });
  const history = passwords.pushHistory(u.password_history, u.password_hash);
  await repos.users.update(req.user.id, {
    passwordHash: passwords.hash(new_password),
    password_history: history,
    password_changed_at: nowLocal(),
    must_change_password: 0
  }, { tenantId: req.user.tenantId });
  await audit({ tenantId: req.user.tenantId, userId: req.user.id, action: 'password_change', targetType: 'user', targetId: req.user.id, ...clientMeta(req) });
  const version = await repos.users.getSessionVersion(req.user.id, { tenantId: req.user.tenantId });
  const token = await signToken({ id: req.user.id, tenant_id: req.user.tenantId, session_version: version });
  res.json({ ok: true, token });
}));

// ===== 用户管理 API =====

// 获取用户列表
router.get('/users', ...adminOnly, asyncH(async (req, res) => {
  const users = await repos.users.list();
  res.json({ users });
}));

// 创建用户
router.post('/users', ...adminOnly, asyncH(async (req, res) => {
  const { username, email, password, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  const v = passwords.validate(password, { username });
  if (!v.ok) return res.status(400).json({ error: v.errors.join('；') });
  if (role !== undefined && !['member', 'admin', 'boss'].includes(role)) return res.status(400).json({ error: '无效角色' });
  const exists = await repos.users.existsByUsernameOrEmail(username, email);
  if (exists) return res.status(409).json({ error: '用户名或邮箱已存在' });
  const hash = passwords.hash(password);
  const id = await repos.tx(async () => {
    const teamId = await repos.teams.create(`${username}的团队`, null);
    const uid = await repos.users.create({ username: String(username), email: email || null, passwordHash: hash, teamId, role: role || 'member' });
    await repos.teams.setOwner(teamId, uid);
    return uid;
  });
  await repos.users.update(id, { password_changed_at: nowLocal() }, { tenantId: req.user.tenantId });
  await audit({ tenantId: req.user.tenantId, userId: req.user.id, action: 'user_create', targetType: 'user', targetId: id, detail: { username, role: role || 'member' }, ...clientMeta(req) });
  res.json({ id, username, email, role: role || 'member' });
}));

// 更新用户
router.put('/users/:id', ...adminOnly, asyncH(async (req, res) => {
  const { id } = req.params;
  const { username, email, password, role } = req.body || {};
  const user = await repos.users.findById(Number(id));
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const fields = {};
  if (username) fields.username = username;
  if (email !== undefined) fields.email = email;
  if (role) {
    if (!['member', 'admin', 'boss'].includes(role)) return res.status(400).json({ error: '无效角色' });
    fields.role = role;
  }
  if (password) {
    const v = passwords.validate(password, { username: username || user.username });
    if (!v.ok) return res.status(400).json({ error: v.errors.join('；') });
    const sec = await repos.users.findSecurity(Number(id), { tenantId: req.user.tenantId });
    fields.passwordHash = passwords.hash(password);
    fields.password_history = passwords.pushHistory(sec && sec.password_history, sec && sec.password_hash);
    fields.password_changed_at = nowLocal();
    fields.must_change_password = 1;
  }
  if (!Object.keys(fields).length) return res.status(400).json({ error: '没有需要更新的字段' });
  await repos.users.update(Number(id), fields, { tenantId: req.user.tenantId });
  await audit({ tenantId: req.user.tenantId, userId: req.user.id, action: 'user_update', targetType: 'user', targetId: Number(id), detail: { fields: Object.keys(fields), password_reset: !!password }, ...clientMeta(req) });
  res.json({ id: Number(id), updated: true });
}));

// 删除用户
router.delete('/users/:id', ...adminOnly, asyncH(async (req, res) => {
  const { id } = req.params;
  if (Number(id) === req.user.id) return res.status(400).json({ error: '不能删除自己' });
  const user = await repos.users.findById(Number(id));
  if (!user) return res.status(404).json({ error: '用户不存在' });
  await repos.users.remove(Number(id));
  await audit({ tenantId: req.user.tenantId, userId: req.user.id, action: 'user_delete', targetType: 'user', targetId: Number(id), ...clientMeta(req) });
  res.json({ deleted: true });
}));

// 获取用户店铺权限
router.get('/users/:id/permissions', ...adminOnly, asyncH(async (req, res) => {
  const permissions = await repos.permissions.listByUser(Number(req.params.id));
  res.json({ permissions });
}));

// 分配用户店铺权限
router.put('/users/:id/permissions', ...adminOnly, asyncH(async (req, res) => {
  const { id } = req.params;
  const { permissions } = req.body || {};
  if (!Array.isArray(permissions)) return res.status(400).json({ error: 'permissions 需为数组' });
  const count = await repos.tx(async () => repos.permissions.replaceForUser(Number(id), permissions));
  await audit({ tenantId: req.user.tenantId, userId: req.user.id, action: 'user_permissions_update', targetType: 'user', targetId: Number(id), detail: { count }, ...clientMeta(req) });
  res.json({ updated: true, count });
}));

module.exports = router;
