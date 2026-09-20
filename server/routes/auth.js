// ===== 认证路由：注册 / 登录 / 当前用户 / 用户管理 =====
// 数据访问统一走仓储层（server/repositories）。
const express = require('express');
const bcrypt = require('bcryptjs');
const { seedTasks } = require('../seed');
const { signToken, authRequired, requireRole, rateLimiter, asyncH } = require('../middleware');
const { repos } = require('../repositories');

const router = express.Router();

// 用户管理仅限管理员
const adminOnly = [authRequired, requireRole('boss', 'admin')];

// 登录/注册接口更严格的限流（防暴力破解）
const authLimiter = rateLimiter(60000, 10, 'auth');
router.get('/config', (req, res) => res.json({ registration_enabled: process.env.ALLOW_REGISTRATION === 'true' }));

// 注册
router.post('/register', authLimiter, asyncH(async (req, res) => {
  if (process.env.ALLOW_REGISTRATION !== 'true') return res.status(403).json({ error: '内部试用暂不开放注册，请联系管理员创建账号' });
  const { username, email, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (String(password).length < 12) return res.status(400).json({ error: '密码长度至少 12 位' });
  if (!/^[\w\u4e00-\u9fa5]{2,20}$/.test(String(username))) {
    return res.status(400).json({ error: '用户名需为 2-20 位字母/数字/中文/下划线' });
  }
  const exists = await repos.users.existsByUsernameOrEmail(username, email);
  if (exists) return res.status(409).json({ error: '用户名或邮箱已被注册' });

  const hash = bcrypt.hashSync(String(password), 10);
  // 自助注册暂归属默认租户 1（多租户开通由超管后台处理）
  const { runWithTenant } = require('../repositories/tenant-context');
  const { userId, teamId } = await runWithTenant(1, () => repos.tx(async () => {
    const tid = await repos.teams.create(`${username}的团队`, null);
    const uid = await repos.users.create({ username: String(username), email: email || null, passwordHash: hash, teamId: tid, tenantId: 1 });
    await repos.teams.setOwner(tid, uid);
    await seedTasks(uid);
    return { userId: uid, teamId: tid };
  }));
  const user = await runWithTenant(1, () => repos.users.findByIdPublic(userId));
  res.json({ token: await signToken({ ...user, team_id: teamId }), user });
}));

// 登录
router.post('/login', authLimiter, asyncH(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  const user = await repos.users.findByLogin(username);
  if (!user || !bcrypt.compareSync(String(password), user.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  res.json({
    token: await signToken(user),
    user: { id: user.id, username: user.username, email: user.email, team_id: user.team_id, role: user.role }
  });
}));

// 当前用户信息
router.get('/me', authRequired, asyncH(async (req, res) => {
  const user = await repos.users.findByIdPublic(req.user.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const team = user.team_id ? await repos.teams.findById(user.team_id) : null;
  res.json({ user: { ...user, team: team ? team.name : null } });
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
  if (String(password).length < 12) return res.status(400).json({ error: '密码长度至少 12 位' });
  if (role !== undefined && !['member', 'admin', 'boss'].includes(role)) return res.status(400).json({ error: '无效角色' });
  const exists = await repos.users.existsByUsernameOrEmail(username, email);
  if (exists) return res.status(409).json({ error: '用户名或邮箱已存在' });
  const hash = bcrypt.hashSync(String(password), 10);
  const id = await repos.tx(async () => {
    const teamId = await repos.teams.create(`${username}的团队`, null);
    const uid = await repos.users.create({ username: String(username), email: email || null, passwordHash: hash, teamId, role: role || 'member' });
    await repos.teams.setOwner(teamId, uid);
    return uid;
  });
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
    if (String(password).length < 12) return res.status(400).json({ error: '密码长度至少 12 位' });
    fields.passwordHash = bcrypt.hashSync(String(password), 10);
  }
  if (!Object.keys(fields).length) return res.status(400).json({ error: '没有需要更新的字段' });
  await repos.users.update(Number(id), fields);
  res.json({ id: Number(id), updated: true });
}));

// 删除用户
router.delete('/users/:id', ...adminOnly, asyncH(async (req, res) => {
  const { id } = req.params;
  if (Number(id) === req.user.id) return res.status(400).json({ error: '不能删除自己' });
  const user = await repos.users.findById(Number(id));
  if (!user) return res.status(404).json({ error: '用户不存在' });
  await repos.users.remove(Number(id));
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
  res.json({ updated: true, count });
}));

module.exports = router;
