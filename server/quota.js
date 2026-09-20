// ===== 租户配额校验 =====
// 建店数量、月度 AI 调用量。优先 Redis 计数，Redis 不可用时回退 DB 计数（agent_runs）。
const { repos } = require('./repositories');
const { getClient } = require('./redis');
const { httpError } = require('./access');
const { requireTenant } = require('./repositories/tenant-context');

async function getTenantLimits(tenantId) {
  const t = await repos.adapter.get('SELECT max_shops, max_ai_calls_per_month, max_cost_per_month FROM tenants WHERE id=?', [tenantId]);
  return {
    maxShops: t && t.max_shops != null ? Number(t.max_shops) : null,
    maxAiCalls: t && t.max_ai_calls_per_month != null ? Number(t.max_ai_calls_per_month) : null,
    maxCost: t && t.max_cost_per_month != null ? Number(t.max_cost_per_month) : null
  };
}

function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

const round4 = v => Math.round(Number(v || 0) * 10000) / 10000;

// 当月用量汇总：AI 调用（ai_usage，权威成本源）+ 智能体运行（agent_runs）
async function getTenantUsage(tenantId, month = monthKey()) {
  const like = month + '%';
  const ai = (await repos.adapter.get(
    `SELECT COUNT(*) calls, COALESCE(SUM(tokens_in),0) tokens_in, COALESCE(SUM(tokens_out),0) tokens_out, COALESCE(SUM(cost),0) cost
     FROM ai_usage WHERE tenant_id=? AND created_at LIKE ?`,
    [tenantId, like]
  )) || {};
  const runs = (await repos.adapter.get(
    `SELECT COUNT(*) runs, COALESCE(SUM(cost),0) cost FROM agent_runs WHERE tenant_id=? AND created_at LIKE ?`,
    [tenantId, like]
  )) || {};
  return {
    month,
    ai: { calls: Number(ai.calls || 0), tokens_in: Number(ai.tokens_in || 0), tokens_out: Number(ai.tokens_out || 0), cost: round4(ai.cost) },
    agent_runs: { runs: Number(runs.runs || 0), cost: round4(runs.cost) }
  };
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

// AI 成本配额校验（当月累计成本，来源 ai_usage）
async function enforceCostQuota(tenantId = requireTenant()) {
  const { maxCost } = await getTenantLimits(tenantId);
  if (!maxCost || maxCost <= 0) return;
  const usage = await getTenantUsage(tenantId);
  if (usage.ai.cost >= maxCost) throw httpError(429, `本月 AI 成本额度已用尽（上限 ¥${maxCost}），请联系管理员`);
}

module.exports = { enforceShopQuota, enforceAiQuota, enforceCostQuota, getTenantLimits, getTenantUsage, monthKey };
