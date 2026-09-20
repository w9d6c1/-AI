// ===== Redis 客户端（限流 / 会话缓存 / 分布式锁）=====
// 分级降级策略：
//  - REDIS_REQUIRED 默认按 NODE_ENV（production=true）决定；true 时连接失败直接启动失败。
//  - 未配置/连接失败时进入降级模式：限流回退内存、会话查 DB、调度锁 fail-closed（除非 SCHEDULER_SINGLE_INSTANCE=true）。
const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || '';
const REQUIRED = process.env.REDIS_REQUIRED != null
  ? process.env.REDIS_REQUIRED === 'true'
  : process.env.NODE_ENV === 'production';

let client = null;
let ready = false;
let lastError = null;

function enabled() { return !!REDIS_URL; }
function required() { return REQUIRED; }

async function initRedis() {
  if (!REDIS_URL) {
    if (REQUIRED) throw new Error('[redis] REDIS_REQUIRED=true 但未配置 REDIS_URL');
    console.warn('[redis] 未配置 REDIS_URL，进入降级模式（限流回退内存 / 调度锁需 SCHEDULER_SINGLE_INSTANCE）');
    return false;
  }
  client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    retryStrategy: (times) => (times > 5 ? null : Math.min(times * 200, 2000))
  });
  client.on('ready', () => { ready = true; });
  client.on('end', () => { ready = false; });
  client.on('error', (e) => { lastError = e.message; });
  try {
    await client.ping();
    ready = true;
    console.log('[redis] 连接就绪');
  } catch (e) {
    ready = false;
    lastError = e.message;
    if (REQUIRED) {
      try { await client.quit(); } catch (_) { /* ignore */ }
      throw new Error('[redis] 连接失败且 REDIS_REQUIRED=true: ' + e.message);
    }
    console.warn('[redis] 连接失败，进入降级模式:', e.message);
  }
  return ready;
}

function getClient() { return ready ? client : null; }

function status() {
  return {
    enabled: enabled(),
    ready,
    required: REQUIRED,
    url: REDIS_URL ? REDIS_URL.replace(/\/\/[^@]*@/, '//***@') : null,
    last_error: lastError
  };
}

async function closeRedis() {
  if (client) { try { await client.quit(); } catch (_) { /* ignore */ } client = null; ready = false; }
}

// ===== 会话版本缓存（读穿；密码变更时失效）=====
function sessionKey(tenantId, userId) { return `sv:${tenantId}:${userId}`; }

async function getSessionVersionCached(tenantId, userId, loader) {
  const redis = getClient();
  if (!redis) return loader();
  const key = sessionKey(tenantId, userId);
  try {
    const v = await redis.get(key);
    if (v !== null) return Number(v);
  } catch (_) { /* ignore, fall through */ }
  const version = await loader();
  try { await redis.set(key, String(version), 'EX', 30); } catch (_) { /* ignore */ }
  return version;
}

async function invalidateSession(tenantId, userId) {
  const redis = getClient();
  if (!redis) return;
  try { await redis.del(sessionKey(tenantId, userId)); } catch (_) { /* ignore */ }
}

module.exports = { initRedis, getClient, status, closeRedis, enabled, required, getSessionVersionCached, invalidateSession };
