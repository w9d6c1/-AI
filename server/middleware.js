// ===== 中间件：鉴权 / 限流 / 错误处理 =====
const jwt = require('jsonwebtoken');
const { repos } = require('./repositories');
const { runWithTenant, runAsPlatform } = require('./repositories/tenant-context');
const { getClient, getSessionVersionCached } = require('./redis');

const JWT_SECRET = process.env.JWT_SECRET || '';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d';

// 生产安全：JWT_SECRET 必须显式配置且足够强，缺失/过短直接启动失败
if (!JWT_SECRET || JWT_SECRET.length < 32 || /change-me|please-change|dev-default/i.test(JWT_SECRET)) {
  throw new Error(
    '[security] 必须配置随机 JWT_SECRET（至少 32 位，禁止示例默认值）。' +
    '请参考 .env.example 创建 .env 后重启。'
  );
}

// 请求级限流：优先 Redis 原子计数，不可用时回退内存窗口
const rateLimiter = (windowMs = 60000, max = 120, scope) => {
  const hits = new Map();
  // 作用域命名空间：不同限流器（全局/登录/报表…）各自独立计数，避免共用计数器互相干扰
  const ns = scope || `${windowMs}:${max}`;
  return async (req, res, next) => {
    const key = 'rl:' + ns + ':' + (req.ip || 'unknown');
    const redis = getClient();
    if (redis) {
      try {
        const n = await redis.incr(key);
        if (n === 1) await redis.pexpire(key, windowMs);
        if (n > max) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
        return next();
      } catch (_) { /* Redis 异常，回退内存 */ }
    }
    const now = Date.now();
    const bucket = hits.get(key) || { count: 0, resetAt: now + windowMs };
    if (bucket.resetAt < now) {
      bucket.count = 0;
      bucket.resetAt = now + windowMs;
    }
    bucket.count++;
    hits.set(key, bucket);
    if (bucket.count > max) {
      return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    }
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k);
    }
    next();
  };
};

// 登录态校验（异步仓储 + 租户上下文）
async function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: '未登录或登录已过期' });

  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); }
  catch (e) { return res.status(401).json({ error: '登录已过期，请重新登录' }); }

  const finish = async () => {
    try {
      const platform = payload.platform === true;
      const ctx = platform ? { platform: true } : { tenantId: payload.tenantId ?? 1 };
      const user = await repos.users.findById(payload.id, ctx);
      if (!user) return res.status(401).json({ error: '登录已失效，请重新登录' });
      const current = await getSessionVersionCached(user.tenant_id ?? 1, user.id, () => repos.users.getSessionVersion(user.id, ctx));
      if (current === null || Number(current) !== Number(payload.sessionVersion ?? 0)) {
        return res.status(401).json({ error: '登录已失效，请重新登录' });
      }
      // 租户状态校验：停用租户的既有 token 立即失效
      if (!platform) {
        const tid = payload.tenantId ?? 1;
        const tenant = await repos.adapter.get('SELECT status FROM tenants WHERE id=?', [tid]);
        if (!tenant || tenant.status !== 'active') {
          return res.status(401).json({ error: '租户已停用，请联系管理员' });
        }
      }
      req.user = {
        id: user.id,
        username: user.username,
        teamId: user.team_id,
        role: user.role || 'member',
        tenantId: platform ? null : (payload.tenantId ?? 1)
      };
      req.impersonatedBy = payload.impersonatedBy ?? null;
      // 代登录只读：非安全方法一律拒绝
      if (req.impersonatedBy && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return res.status(403).json({ error: '代登录为只读模式，禁止写操作' });
      }
      next();
    } catch (e) {
      return res.status(401).json({ error: '登录已过期，请重新登录' });
    }
  };

  if (payload.platform === true) return runAsPlatform(finish, { impersonatedBy: payload.impersonatedBy ?? null });
  return runWithTenant(payload.tenantId ?? 1, finish);
}

// 签发 token（异步：必要时从仓储读取当前 session_version）
async function signToken(user) {
  const platform = user.role === 'superadmin';
  let version = user.session_version;
  if (version === undefined || version === null) {
    version = platform
      ? await repos.users.getSessionVersion(user.id, { platform: true })
      : await repos.users.getSessionVersion(user.id, { tenantId: user.tenant_id ?? 1 });
  }
  const payload = { id: user.id, sessionVersion: version ?? 0, tenantId: platform ? null : (user.tenant_id ?? 1) };
  if (platform) payload.platform = true;
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

// 代登录 token：短时（15 分钟）、只读（由 authRequired 强制）、带 impersonatedBy 审计标记
async function signImpersonation(adminId, targetUser) {
  let version = targetUser.session_version;
  if (version === undefined || version === null) {
    version = await repos.users.getSessionVersion(targetUser.id, { platform: true });
  }
  return jwt.sign(
    { id: targetUser.id, sessionVersion: version ?? 0, tenantId: targetUser.tenant_id ?? 1, impersonatedBy: adminId },
    JWT_SECRET,
    { expiresIn: '15m' }
  );
}

// 角色校验（用于管理类接口）
function requireRole(...roles) {
  return (req, res, next) => {
    const role = (req.user && req.user.role) || 'member';
    if (!roles.includes(role)) {
      return res.status(403).json({ error: '无权限执行该操作' });
    }
    next();
  };
}

// 统一错误处理
function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  try {
    require('./logger').error('请求处理失败', { requestId: req.requestId, method: req.method, path: req.originalUrl, status, error: err.message });
    require('./metrics').inc('http_errors_total', { status });
  } catch (_) { /* 日志/指标失败不阻断 */ }
  if (res.headersSent) return next(err);
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '文件不能超过 50MB' });
  if (err.code && String(err.code).startsWith('LIMIT_')) return res.status(400).json({ error: '上传请求无效' });
  res.status(status).json({ error: err.message || '服务器内部错误' });
}

// 异步包装
const asyncH = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { authRequired, requireRole, signToken, signImpersonation, rateLimiter, errorHandler, asyncH };
