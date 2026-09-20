// ===== 用量与成本记录 =====
// 内存统计 + 租户上下文内落库 ai_usage（记录失败不影响主流程）。
const { repos } = require('../../repositories');
const { currentTenant } = require('../../repositories/tenant-context');

const stats = { total: 0, tokensIn: 0, tokensOut: 0, cost: 0, byProvider: {} };

async function recordUsage({ provider, capability, model, tokensIn = 0, tokensOut = 0, priceIn = 0, priceOut = 0 }) {
  const cost = (tokensIn / 1000) * priceIn + (tokensOut / 1000) * priceOut;
  stats.total++;
  stats.tokensIn += tokensIn;
  stats.tokensOut += tokensOut;
  stats.cost += cost;
  if (!stats.byProvider[provider]) stats.byProvider[provider] = { calls: 0, tokensIn: 0, tokensOut: 0, cost: 0 };
  const p = stats.byProvider[provider];
  p.calls++; p.tokensIn += tokensIn; p.tokensOut += tokensOut; p.cost += cost;

  const t = currentTenant();
  if (t == null) return;
  try {
    await repos.adapter.run(
      'INSERT INTO ai_usage (tenant_id, provider, capability, model, tokens_in, tokens_out, cost) VALUES (?,?,?,?,?,?,?)',
      [t, provider, capability, model || '', tokensIn, tokensOut, Math.round(cost * 10000) / 10000]
    );
  } catch (e) { /* 记录失败不影响主流程 */ }
}

function getUsageStats() {
  return { total: stats.total, tokens_in: stats.tokensIn, tokens_out: stats.tokensOut, cost: Math.round(stats.cost * 10000) / 10000, by_provider: stats.byProvider };
}

module.exports = { recordUsage, getUsageStats };
