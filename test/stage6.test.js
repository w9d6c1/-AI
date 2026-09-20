const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('node:http');
const bcrypt = require('bcryptjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecom-stage6-'));
Object.assign(process.env, {
  DATA_DIR: path.join(root, 'data'), DB_PATH: path.join(root, 'data/ecom-ai.db'), UPLOAD_DIR: path.join(root, 'uploads'),
  JWT_SECRET: crypto.randomBytes(32).toString('hex'), RPA_CALLBACK_TOKEN: 'stage6-token',
  DB_DRIVER: 'sqlite', RPA_MOCK_MODE: 'true', EXECUTOR_DRIVER: 'manual', AUTO_EXECUTE_ENABLED: 'false',
  QUEUE_ENABLED: 'false', STORAGE_DRIVER: 'local', ENABLE_SCHEDULER: 'false',
  SEED_DEFAULT_USERS: 'false', SEED_DEMO_DATA: 'false', ALLOW_REGISTRATION: 'false',
  AI_API_KEY: '', AI_IMAGE_API_KEY: '', AI_PROVIDERS: '',
  LOG_DIR: path.join(root, 'logs'), LOG_LEVEL: 'debug', LOG_CONSOLE: 'false', LOG_MAX_BYTES: '2000', LOG_MAX_FILES: '3'
});

const app = require('../server/index');
const { defaultAdapter } = require('../server/repositories');
const { runWithTenant } = require('../server/repositories/tenant-context');
const { signToken } = require('../server/middleware');
const { db } = require('../server/db');
const logger = require('../server/logger');
const metrics = require('../server/metrics');
const { readiness } = require('../server/health');
const { shutdown } = require('../server/lifecycle');
const { workerConcurrency } = require('../server/queue/workers');
const { snapshot } = require('../scripts/backup');
const { drill } = require('../scripts/drill');

let server, base, token;

before(async () => {
  await runWithTenant(1, async () => {
    const adminId = (await defaultAdapter.run('INSERT INTO users (tenant_id,username,password_hash,role) VALUES (?,?,?,?)', [1, 'admin', bcrypt.hashSync('x', 4), 'admin'])).lastInsertRowid;
    token = await signToken({ id: adminId, tenant_id: 1, session_version: 0 });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});

after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  try { db.close(); } catch (_) { /* ignore */ }
  const resolved = path.resolve(root);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('ecom-stage6-')) fs.rmSync(resolved, { recursive: true, force: true });
});

test('P6-1 结构化日志：JSON 行 + 大小轮转', () => {
  logger.info('unit test log', { requestId: 'r1', n: 1 });
  const logFile = logger._paths.LOG_FILE;
  assert.ok(fs.existsSync(logFile));
  const first = fs.readFileSync(logFile, 'utf8').trim().split('\n')[0];
  const rec = JSON.parse(first);
  assert.equal(rec.level, 'info');
  assert.ok(rec.ts && rec.msg);
  // 触发轮转
  for (let i = 0; i < 200; i++) logger.debug('rotate filler', { i, pad: 'x'.repeat(50) });
  assert.ok(fs.existsSync(logFile + '.1'), '未生成轮转文件');
});

test('P6-2 指标：计数/直方图快照', () => {
  metrics.reset();
  metrics.inc('t_total', { method: 'GET' });
  metrics.inc('t_total', { method: 'GET' });
  metrics.inc('t_total', { method: 'POST' });
  metrics.observe('t_ms', 10);
  metrics.observe('t_ms', 30);
  const s = metrics.snapshot();
  assert.equal(s.counters['t_total{method=GET}'], 2);
  assert.equal(s.counters['t_total{method=POST}'], 1);
  assert.equal(s.histograms['t_ms'].count, 2);
  assert.equal(s.histograms['t_ms'].max_ms, 30);
  assert.ok(s.uptime_sec >= 0);
});

test('P6-2 readiness：DB/Redis/AI/采集器/存储/队列', async () => {
  const r = await readiness();
  assert.ok(r.checks.db && r.checks.db.ok);
  assert.equal(r.checks.db.required, true);
  assert.ok(r.checks.redis);
  assert.ok(r.checks.ai);
  assert.ok(r.checks.collector.ok);
  assert.ok(r.checks.storage.ok);
  assert.ok(r.checks.queue);
  assert.equal(r.ready, true);

  const resp = await fetch(base + '/api/health/ready');
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.ready, true);
  assert.ok(body.checks.db.ok);
});

test('P6-2 指标端点：请求计数与错误追踪', async () => {
  await fetch(base + '/api/health');
  const resp = await fetch(base + '/api/health/metrics');
  assert.equal(resp.status, 200);
  const m = await resp.json();
  assert.ok(m.counters['http_requests_total{method=GET}'] >= 1);
  assert.ok(m.histograms['http_request_duration_ms{method=GET}']);
});

test('P6-3 优雅停机：关闭 HTTP 服务且幂等', async () => {
  const srv = http.createServer((req, res) => res.end('ok'));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  assert.equal(srv.listening, true);
  const steps = await shutdown({ server: srv });
  assert.equal(srv.listening, false);
  assert.ok(steps.some(s => s.name === 'http_close' && s.ok));
  const again = await shutdown({ server: srv });
  assert.ok(Array.isArray(again));
});

test('P6-4 队列并发可配（默认 5，上限 50）', () => {
  const saved = process.env.QUEUE_CONCURRENCY;
  delete process.env.QUEUE_CONCURRENCY;
  assert.equal(workerConcurrency(), 5);
  process.env.QUEUE_CONCURRENCY = '10';
  assert.equal(workerConcurrency(), 10);
  process.env.QUEUE_CONCURRENCY = '999';
  assert.equal(workerConcurrency(), 50);
  if (saved === undefined) delete process.env.QUEUE_CONCURRENCY; else process.env.QUEUE_CONCURRENCY = saved;
});

test('P6-5 备份：SQLite 快照 + 异地副本 + 清单元数据', () => {
  const backupDir = path.join(root, 'backup1');
  const offsite = path.join(root, 'offsite');
  process.env.OFFSITE_BACKUP_DIR = offsite;
  try {
    snapshot({ dbPath: process.env.DB_PATH, dataDir: process.env.DATA_DIR, uploadDir: process.env.UPLOAD_DIR, destination: backupDir, driver: 'sqlite' });
    assert.ok(fs.existsSync(path.join(backupDir, 'ecom-ai.db')));
    const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.database.db, 'sqlite');
    assert.ok(manifest.files.some(f => f.path === 'ecom-ai.db'));
    assert.ok(fs.existsSync(path.join(offsite, 'backup1', 'manifest.json')), '异地副本缺失');
  } finally { delete process.env.OFFSITE_BACKUP_DIR; }
});

test('P6-5 演练：备份→恢复→行数校验', () => {
  const r = drill({ dbPath: process.env.DB_PATH, dataDir: process.env.DATA_DIR, uploadDir: process.env.UPLOAD_DIR });
  assert.equal(r.ok, true);
  assert.ok(r.counts.users.ok);
  assert.ok(r.counts.shops.ok);
});

test('P6-5 PG 备份：失败时给出明确错误（pg_dump）', () => {
  const dest = path.join(root, 'backup-pg');
  assert.throws(() => snapshot({
    databaseUrl: 'postgres://x:y@127.0.0.1:1/none',
    destination: dest,
    driver: 'postgres',
    dataDir: process.env.DATA_DIR,
    uploadDir: process.env.UPLOAD_DIR
  }), /pg_dump/);
});
