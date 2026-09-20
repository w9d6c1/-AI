// ===== 租户配额校验 =====
// 建店数量、月度 AI 调用量。优先 Redis 计数，Redis 不可用时回退 DB 计数（agent_runs）。
const { repos } = require('./repositories');
const { getClient } = require('./redis');
const { httpError } = require('./access');
const { requireTenant } = require('./repositories/tenant-context');

async function getTenantLimits(tenantId) {
  const t = await repos.adapter.get('SELECT max_shops, max_ai_calls_per_month FROM tenants WHERE id=?', [tenantId]);
  return {
    maxShops: t && t.max_shops != null ? Number(t.max_shops) : null,
    maxAiCalls: t && t.max_ai_calls_per_month != null ? Number(t.max_ai_calls_per_month) : null
  };
}

function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

// 建店前校验
async function enforceShopQuota(tenantId = requireTenant()) {
  const { maxShops } = await getTenantLimits(tenantId);
  if (!maxShops || maxShops <= 0) return;
  const used = Number((await repos.adapter.get('SELECT COUNT(*) AS c FROM shops WHERE tenant_id=?', [tenantId])).c);
  if (used >= maxShops) throw httpError(403, `租户店铺数已达上限（${maxShops}）`);
}

// AI 调用前校验；通过后计数 +1
async function enforceAiQuota(tenantId = requireTenant()) {
  const { maxAiCalls } = await getTenantLimits(tenantId);
  if (!maxAiCalls || maxAiCalls <= 0) return;
  const month = monthKey();
  const redis = getClient();
  if (redis) {
    const key = `ai:${tenantId}:${month}`;
    const used = await redis.incr(key);
    if (used === 1) await redis.expire(key, 40 * 24 * 3600);
    if (used > maxAiCalls) {
      try { await redis.decr(key); } catch (_) { /* ignore */ }
      throw httpError(429, '本月 AI 调用额度已用尽，请联系管理员');
    }
    return;
  }
  // 回退：按 agent_runs 当月计数
  const used = Number((await repos.adapter.get('SELECT COUNT(*) AS c FROM agent_runs WHERE tenant_id=? AND created_at LIKE ?', [tenantId, month + '%'])).c);
  if (used >= maxAiCalls) throw httpError(429, '本月 AI 调用额度已用尽，请联系管理员');
}

module.exports = { enforceShopQuota, enforceAiQuota, getTenantLimits, monthKey };
