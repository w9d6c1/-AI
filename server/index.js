// ===== 服务入口 =====
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const crypto = require('crypto');
const { seedCourses, seedShops, seedDefaultUsers, seedSuperadmin } = require('./seed');
const { rateLimiter, errorHandler, authRequired, asyncH } = require('./middleware');
const { UPLOAD_DIR, registerFile, fileAccess } = require('./files');
const { startScheduler } = require('./scheduler');
const { seedDefaultRules } = require('./alert');
const logger = require('./logger');
const metrics = require('./metrics');
const { readiness } = require('./health');
const { installSignalHandlers } = require('./lifecycle');

const app = express();
const PORT = process.env.PORT || 3000;

// 上传目录
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const ALLOWED_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp',
  '.pdf', '.txt', '.csv', '.xls', '.xlsx', '.doc', '.docx', '.ppt', '.pptx'
]);
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const safe = crypto.randomUUID() + ext;
      cb(null, safe);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_EXT.has(ext)) return cb(Object.assign(new Error('不支持的文件类型：' + (ext || '未知')), { status: 400 }));
    cb(null, true);
  }
});

// 反向代理后获取真实客户端 IP（限流与审计需要）
if (process.env.TRUST_PROXY) {
  const tp = process.env.TRUST_PROXY;
  app.set('trust proxy', tp === 'true' ? 1 : (Number(tp) || tp));
}

// CORS：默认仅允许同源/配置来源（生产请显式设置 CORS_ORIGIN，逗号分隔）
const CORS_ORIGIN = process.env.CORS_ORIGIN;
app.use(cors(CORS_ORIGIN ? { origin: CORS_ORIGIN.split(',').map(s => s.trim()) } : { origin: false }));

// 基础安全响应头
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0');
  next();
});

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// 请求 ID + 结构化日志 + 指标
app.use((req, res, next) => {
  const requestId = crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  const start = process.hrtime.bigint();
  metrics.inc('http_requests_total', { method: req.method });
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    metrics.observe('http_request_duration_ms', ms, { method: req.method });
    metrics.inc('http_responses_total', { status: res.statusCode });
    if (req.path.startsWith('/api') || res.statusCode >= 400) {
      logger.info('http', { requestId, method: req.method, path: req.originalUrl, status: res.statusCode, duration_ms: Math.round(ms * 100) / 100 });
    }
  });
  next();
});

// 全局限流
app.use('/api/', rateLimiter(60000, 300, 'global'));

// 健康检查
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// 就绪检查：DB / Redis / AI / 采集器 / 存储 / 队列
app.get('/api/health/ready', asyncH(async (req, res) => {
  const { ready, checks } = await readiness();
  res.status(ready ? 200 : 503).json({ ready, checks });
}));

// 指标与错误追踪
app.get('/api/health/metrics', (req, res) => {
  res.json(metrics.snapshot());
});

// 静态前端
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', fileAccess, express.static(UPLOAD_DIR, { dotfiles: 'deny', fallthrough: false }));

// 路由
// RPA 回调（无 JWT，x-callback-token 校验）必须先于带 authRequired 的路由挂载
app.use('/api', require('./routes/rpa-callback'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/chat'));
app.use('/api', require('./routes/agents'));
app.use('/api', require('./routes/business'));
app.use('/api', require('./routes/stores'));
app.use('/api', require('./routes/imports'));
app.use('/api', require('./routes/scheduler'));
app.use('/api', require('./routes/alerts'));
app.use('/api', require('./routes/batch'));
app.use('/api', require('./routes/reports'));
app.use('/api/admin', require('./routes/admin'));

// 数据看板：真实聚合（daily_reports / ad_campaigns / orders_daily / refunds_daily / product_daily）
app.get('/api/dashboard/stats', authRequired, asyncH(async (req, res) => {
  const { resolveShopIds } = require('./access');
  const { getDashboardStats } = require('./dashboard');
  const { requireTenant } = require('./repositories/tenant-context');
  let shopIds = await resolveShopIds(req.user, req.query.shop_ids);
  const platform = req.query.platform;
  if (platform && shopIds.length) {
    const t = requireTenant();
    const { repos } = require('./repositories');
    shopIds = (await repos.adapter.all(
      `SELECT id FROM shops WHERE tenant_id=? AND id IN (${shopIds.join(',')}) AND platform=?`,
      [t, platform]
    )).map(r => r.id);
  }
  res.json(await getDashboardStats({ shopIds, range: req.query.range || '30d' }));
}));

// 看板账号维度下钻：某广告账号的计划明细
app.get('/api/dashboard/accounts/:accountId/campaigns', authRequired, asyncH(async (req, res) => {
  const { resolveShopIds } = require('./access');
  const { getAccountCampaigns } = require('./dashboard');
  const shopIds = await resolveShopIds(req.user, req.query.shop_ids);
  res.json(await getAccountCampaigns({ accountId: req.params.accountId, shopIds, range: req.query.range || '30d' }));
}));

// 文件上传（AI 对话附件 / 图生图参考图等）
app.post('/api/upload', authRequired, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    // 病毒扫描（SCAN_UPLOADS=true 时）
    const { scanBuffer } = require('./security/scan');
    const scan = await scanBuffer(fs.readFileSync(req.file.path), req.file.originalname);
    if (!scan.ok) {
      try { fs.unlinkSync(req.file.path); } catch (_) { /* ignore */ }
      return res.status(400).json({ error: '文件未通过安全扫描', detail: scan.reason });
    }
    const storage = require('./integrations/storage');
    if (!storage.isLocal()) {
      const buf = fs.readFileSync(req.file.path);
      await storage.put(req.file.filename, buf, req.file.mimetype);
      fs.unlinkSync(req.file.path);
    }
    res.json({
      url: await registerFile(req.user, `/uploads/${req.file.filename}`),
      name: req.file.originalname,
      size: req.file.size,
      mime: req.file.mimetype
    });
  } catch (e) { next(e); }
});

// SPA 回退
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use(errorHandler);

// 启动
if (require.main === module) {
(async () => {
  const { runMigrations } = require('./migrations');
  const { defaultAdapter } = require('./repositories');
  const { runWithTenant, runAsPlatform } = require('./repositories/tenant-context');
  const { initRedis } = require('./redis');
  await initRedis();
  const { init: initQueue } = require('./queue');
  const { startWorkers } = require('./queue/workers');
  initQueue();
  await startWorkers();
  const storage = require('./integrations/storage');
  if (storage.driver === 's3') { await storage.ensureBucket(); console.log('[storage] s3 桶已就绪'); }
  if (defaultAdapter.dialect === 'postgres') {
    const { bootstrapPostgres } = require('./db/pg-schema');
    await bootstrapPostgres(defaultAdapter);
    console.log('[db] Postgres schema 已就绪');
  }
  const applied = await runMigrations(defaultAdapter);
  if (applied.length) console.log(`[migrations] 已应用: ${applied.join(', ')}`);
  await runWithTenant(1, async () => {
    await seedCourses();
    if (process.env.SEED_DEMO_DATA === 'true') await seedShops();
    await seedDefaultRules();
    await seedDefaultUsers();
  });
  await runAsPlatform(() => seedSuperadmin());
  await startScheduler();
  const server = app.listen(PORT, () => {
    logger.info('server started', { port: PORT, db: defaultAdapter.dialect, ai: !!process.env.AI_API_KEY, rpa_mock: process.env.RPA_MOCK_MODE !== 'false' });
    console.log(`\n  国内电商AI平台 — 电商经营全链路智能平台`);
    console.log(`  ➜ 本地访问:  http://localhost:${PORT}`);
    console.log(`  ➜ AI 模式:   ${process.env.AI_API_KEY ? '真实大模型（已配置 API Key）' : '内置规则引擎（未配置 API Key，见 .env）'}`);
    console.log(`  ➜ RPA 模式:  ${process.env.RPA_MOCK_MODE !== 'false' ? 'Mock 模式（自动生成测试数据）' : '真实模式（调影刀 OpenAPI）'}\n`);
  });
  installSignalHandlers(server);
  process.on('unhandledRejection', (e) => logger.error('unhandledRejection', { error: e && e.message ? e.message : String(e) }));
  process.on('uncaughtException', (e) => logger.error('uncaughtException', { error: e.message, stack: e.stack }));
})().catch((e) => {
  logger.error('启动失败', { error: e.message });
  console.error('[startup] 启动失败:', e);
  process.exit(1);
});
}
module.exports = app;
