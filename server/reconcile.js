// ===== 对账：建议值(期望) vs 实际值 =====
// 期望值来自创建执行时的快照 executions.expected_value；实际值来自回填或回调 actual_value。
const { repos } = require('./repositories');
const { requireTenant } = require('./repositories/tenant-context');

async function reconcileReport({ shopIds = [], dateStart, dateEnd, shopId, limit = 1000 } = {}) {
  const t = requireTenant();
  const ph = shopIds.length ? shopIds.join(',') : '0';
  const params = [t, dateStart, dateEnd];
  let shopFilter = '';
  if (shopId) { shopFilter = ' AND e.shop_id=?'; params.push(Number(shopId)); }
  const rows = await repos.adapter.all(
    `SELECT e.id, e.shop_id, s.shop_name, e.action_type, e.target_campaign_id,
            e.expected_value, e.before_value, e.actual_value, e.status, e.is_auto,
            e.rollback_of, e.finished_at, e.created_at
     FROM executions e LEFT JOIN shops s ON e.shop_id=s.id AND s.tenant_id=e.tenant_id
     WHERE e.tenant_id=? AND e.shop_id IN (${ph}) AND e.created_at >= ? AND e.created_at <= ?${shopFilter}
     ORDER BY e.id DESC LIMIT ?`,
    [...params, limit]
  );

  const items = rows.map(r => {
    const expected = r.expected_value;
    const actual = r.actual_value;
    const diff = (expected != null && actual != null) ? Math.round((actual - expected) * 10000) / 10000 : null;
    return { ...r, diff, matched: diff === null ? null : Math.abs(diff) < 1e-9 };
  });

  const comparable = items.filter(i => i.matched !== null);
  const matched = comparable.filter(i => i.matched).length;
  const byAction = {};
  for (const i of comparable) {
    if (!byAction[i.action_type]) byAction[i.action_type] = { total: 0, matched: 0, sum_abs_diff: 0 };
    byAction[i.action_type].total++;
    if (i.matched) byAction[i.action_type].matched++;
    byAction[i.action_type].sum_abs_diff = Math.round((byAction[i.action_type].sum_abs_diff + Math.abs(i.diff)) * 100) / 100;
  }

  const summary = {
    total: items.length,
    comparable: comparable.length,
    matched,
    mismatched: comparable.length - matched,
    unmatched: items.length - comparable.length,
    match_rate: comparable.length ? Math.round((matched / comparable.length) * 1000) / 10 : null,
    sum_abs_diff: Math.round(comparable.reduce((s, i) => s + Math.abs(i.diff), 0) * 100) / 100
  };
  return { summary, by_action: byAction, rows: items };
}

module.exports = { reconcileReport };
