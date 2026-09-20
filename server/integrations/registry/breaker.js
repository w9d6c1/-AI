// ===== 熔断器 =====
// 连续失败达到阈值后，冷却期内跳过该 provider。优先 Redis，降级内存。
const { getClient } = require('../../redis');

const THRESHOLD = Number(process.env.CB_THRESHOLD || 5);
const COOLDOWN_MS = Number(process.env.CB_COOLDOWN_MS || 60000);
const mem = new Map(); // id -> { fails, openUntil }

function key(id) { return 'cb:' + id; }

async function isOpen(id) {
  const redis = getClient();
  if (redis) {
    try { return !!(await redis.get(key(id))); } catch (_) { /* fall through */ }
  }
  const s = mem.get(id);
  return !!(s && s.openUntil > Date.now());
}

async function onFailure(id) {
  const redis = getClient();
  if (redis) {
    try {
      const n = await redis.incr(key(id) + ':fails');
      if (n === 1) await redis.pexpire(key(id) + ':fails', COOLDOWN_MS * 2);
      if (n >= THRESHOLD) await redis.set(key(id), '1', 'PX', COOLDOWN_MS);
      return;
    } catch (_) { /* fall through */ }
  }
  const s = mem.get(id) || { fails: 0, openUntil: 0 };
  s.fails += 1;
  if (s.fails >= THRESHOLD) { s.openUntil = Date.now() + COOLDOWN_MS; s.fails = 0; }
  mem.set(id, s);
}

async function onSuccess(id) {
  const redis = getClient();
  if (redis) {
    try { await redis.del(key(id), key(id) + ':fails'); return; } catch (_) { /* fall through */ }
  }
  mem.delete(id);
}

function status() {
  const out = {};
  for (const [id, s] of mem) out[id] = { fails: s.fails, open: s.openUntil > Date.now() };
  return out;
}

module.exports = { isOpen, onFailure, onSuccess, status, THRESHOLD, COOLDOWN_MS };
