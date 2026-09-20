// ===== 就绪探针：DB / Redis / AI / 采集器 / 存储 / 队列 =====
const { status: redisStatus, getClient } = require('./redis');

async function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} 超时`)), ms))
  ]);
}

async function readiness() {
  const checks = {};

  // DB
  try {
    const { defaultAdapter } = require('./repositories');
    await withTimeout(defaultAdapter.get('SELECT 1 AS ok'), 1000, 'db');
    checks.db = { ok: true, required: true, dialect: defaultAdapter.dialect };
  } catch (e) {
    checks.db = { ok: false, required: true, error: e.message };
  }

  // Redis
  const rs = redisStatus();
  let redisOk = !rs.enabled ? !rs.required : rs.ready;
  if (rs.enabled) {
    const rc = getClient();
    if (rc) {
      try { await withTimeout(rc.ping(), 300, 'redis'); redisOk = true; }
      catch (e) { redisOk = false; rs.last_error = e.message; }
    } else redisOk = false;
  }
  checks.redis = { ok: redisOk, required: rs.required, enabled: rs.enabled, ready: rs.ready, last_error: rs.last_error };

  // AI（可选：未配置时降级规则引擎，不阻塞就绪）
  try {
    const ai = require('./ai');
    checks.ai = { ok: ai.aiEnabled() || ai.imageEnabled(), required: false, chat: ai.aiEnabled(), image: ai.imageEnabled() };
  } catch (e) {
    checks.ai = { ok: false, required: false, error: e.message };
  }

  // 采集器
  try {
    const collectors = require('./integrations/collectors');
    const list = collectors.list();
    checks.collector = { ok: list.length > 0, required: true, collectors: list.map(c => c.id) };
  } catch (e) {
    checks.collector = { ok: false, required: true, error: e.message };
  }

  // 存储（本地目录可写 / S3 桶可访问）
  try {
    const storage = require('./integrations/storage');
    const p = await withTimeout(storage.ping(), 1500, 'storage');
    checks.storage = { ok: !!p.ok, required: true, driver: storage.driver, detail: p };
  } catch (e) {
    checks.storage = { ok: false, required: true, driver: process.env.STORAGE_DRIVER || 'local', error: e.message };
  }

  // 队列（仅启用时纳入就绪）
  try {
    const queue = require('./queue');
    const enabled = queue.enabled();
    const conn = queue.getConnection();
    checks.queue = { ok: enabled ? !!conn : true, required: enabled, enabled };
  } catch (e) {
    checks.queue = { ok: true, required: false, error: e.message };
  }

  const ready = Object.values(checks).every(c => (c.required ? c.ok : true));
  return { ready, checks };
}

module.exports = { readiness };
