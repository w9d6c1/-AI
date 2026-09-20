// ===== BullMQ 队列骨架 =====
// 开关：QUEUE_ENABLED=true 且配置 REDIS_URL 时启用；否则 enqueue 返回 false，调用方走同步回退。
const IORedis = require('ioredis');

const QUEUE_NAMES = ['collect', 'suggest', 'notify', 'report'];
const REDIS_URL = process.env.REDIS_URL || '';
const ENABLED = process.env.QUEUE_ENABLED === 'true' && !!REDIS_URL;

let connection = null;
let Queue = null;
const queues = new Map();
let ready = false;

function enabled() { return ENABLED; }

function init() {
  if (!ENABLED || connection) return;
  try {
    ({ Queue } = require('bullmq'));
    connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
    connection.on('error', (e) => console.warn('[queue] redis 错误:', e.message));
    for (const name of QUEUE_NAMES) {
      queues.set(name, new Queue(name, { connection }));
    }
    ready = true;
    console.log('[queue] BullMQ 已启用:', QUEUE_NAMES.join(', '));
  } catch (e) {
    console.warn('[queue] 初始化失败，回退同步模式:', e.message);
    ready = false;
  }
}

function getConnection() { return connection; }
function getQueue(name) { return queues.get(name); }

// 入队；未启用或异常返回 false（调用方同步回退）
async function enqueue(name, data, opts = {}) {
  if (!ready) return false;
  const q = queues.get(name);
  if (!q) return false;
  try {
    await q.add(name, data, { attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 1000, removeOnFail: 5000, ...opts });
    return true;
  } catch (e) {
    console.warn(`[queue] 入队失败(${name})，回退同步:`, e.message);
    return false;
  }
}

async function closeQueues() {
  for (const q of queues.values()) { try { await q.close(); } catch (_) { /* ignore */ } }
  queues.clear();
  if (connection) { try { await connection.quit(); } catch (_) { /* ignore */ } connection = null; }
  ready = false;
}

module.exports = { QUEUE_NAMES, enabled, init, getConnection, getQueue, enqueue, closeQueues };
