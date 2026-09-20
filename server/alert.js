// ===== 预警检测服务 =====
// 内置规则类型：burn（空烧）、roi_drop（ROI骤降）、cost_overrun（花费超标）、conv_drop（转化率下降）
const { repos } = require('./repositories');
const { currentTenant } = require('./repositories/tenant-context');
const { enqueue } = require('./queue');
const { sendNotifications } = require('./notifier');
const { todayLocal, dateLocalOffset, nowLocal } = require('./util');
const { requireTenant } = require('./repositories/tenant-context');

const DEFAULT_RULES = [
  { name: '空烧预警', rule_type: 'burn', conditions: JSON.stringify({ min_cost: 100, max_roi: 1.0 }), severity: 'critical', target_type: 'all', cooldown_hours: 6 },
  { name: 'ROI骤降预警', rule_type: 'roi_drop', conditions: JSON.stringify({ drop_percent: 50, min_cost: 50 }), severity: 'warning', target_type: 'all', cooldown_hours: 12 },
  { name: '花费超标预警', rule_type: 'cost_overrun', conditions: JSON.stringify({ daily_budget: 3000 }), severity: 'warning', target_type: 'all', cooldown_hours: 24 },
  { name: '转化率下降预警', rule_type: 'conv_drop', conditions: JSON.stringify({ drop_percent: 40 }), severity: 'info', target_type: 'all', cooldown_hours: 24 }
];

async function seedDefaultRules() {
  const t = requireTenant();
  const count = (await repos.adapter.get('SELECT COUNT(*) AS c FROM alert_rules WHERE tenant_id=?', [t])).c;
  if (Number(count) > 0) return;
  for (const r of DEFAULT_RULES) {
    await repos.adapter.run(
      'INSERT INTO alert_rules (name, rule_type, conditions, severity, target_type, target_ids, enabled, cooldown_hours, tenant_id) VALUES (?,?,?,?,?,?,?,?,?)',
      [r.name, r.rule_type, r.conditions, r.severity, r.target_type, null, 1, r.cooldown_hours, t]
    );
  }
  console.log(`[alert] 已注入 ${DEFAULT_RULES.length} 条默认预警规则`);
}

async function getRuleTargetShops(rule) {
  const t = requireTenant();
  if (rule.target_type === 'all') {
    return repos.adapter.all("SELECT * FROM shops WHERE status='active' AND tenant_id=?", [t]);
  }
  if (rule.target_type === 'group') {
    const ids = JSON.parse(rule.target_ids || '[]');
    if (!ids.length) return [];
    return repos.adapter.all(`SELECT * FROM shops WHERE status='active' AND group_id IN (${ids.map(() => '?').join(',')}) AND tenant_id=?`, [...ids, t]);
  }
  if (rule.target_type === 'specific') {
    const ids = JSON.parse(rule.target_ids || '[]');
    if (!ids.length) return [];
    return repos.adapter.all(`SELECT * FROM shops WHERE status='active' AND id IN (${ids.map(() => '?').join(',')}) AND tenant_id=?`, [...ids, t]);
  }
  return [];
}

async function isInCooldown(ruleId, shopId, campaignId, cooldownHours) {
  const t = requireTenant();
  // 与 DB 默认时间格式（YYYY-MM-DD HH:mm:ss）保持一致，避免字符串比较失效
  const since = nowLocal(new Date(Date.now() - cooldownHours * 3600000));
  // 避免 `? IS NULL`（PG 无法推断参数类型）：按 campaignId 是否为空分别构造条件
  const base = 'SELECT id FROM alerts WHERE rule_id=? AND shop_id=? AND triggered_at>? AND tenant_id=?';
  const existing = campaignId == null
    ? await repos.adapter.get(base + ' AND campaign_id IS NULL LIMIT 1', [ruleId, shopId, since, t])
    : await repos.adapter.get(base + ' AND campaign_id=? LIMIT 1', [ruleId, shopId, since, t, campaignId]);
  return !!existing;
}

async function createAlert(ruleId, shopId, campaignId, alertType, severity, title, message, metrics) {
  const t = requireTenant();
  const info = await repos.adapter.run(
    'INSERT INTO alerts (rule_id, shop_id, campaign_id, alert_type, severity, title, message, metrics_json, tenant_id) VALUES (?,?,?,?,?,?,?,?,?)',
    [ruleId, shopId, campaignId || null, alertType, severity, title, message, metrics ? JSON.stringify(metrics) : null, t]
  );
  const alertId = info.lastInsertRowid;
  const queued = await enqueue('notify', { tenantId: currentTenant() ?? 1, alertId });
  if (!queued) sendNotifications(alertId).catch(e => console.error('[alert] 通知发送失败:', e.message));
  return alertId;
}

async function checkBurn(rule, shops, today) {
  const t = requireTenant();
  const cond = JSON.parse(rule.conditions);
  const results = [];
  for (const shop of shops) {
    const campaigns = await repos.adapter.all('SELECT * FROM ad_campaigns WHERE shop_id=? AND report_date=? AND cost>? AND roi<? AND tenant_id=?', [shop.id, today, cond.min_cost, cond.max_roi, t]);
    for (const c of campaigns) {
      if (await isInCooldown(rule.id, shop.id, c.campaign_id, rule.cooldown_hours)) continue;
      const msg = `店铺「${shop.shop_name}」计划「${c.campaign_name}」空烧：花费 ¥${c.cost}，ROI 仅 ${c.roi}`;
      const alertId = await createAlert(rule.id, shop.id, c.campaign_id, 'burn', rule.severity, `空烧预警: ${shop.shop_name} - ${c.campaign_name}`, msg, { cost: c.cost, roi: c.roi, campaign_name: c.campaign_name });
      results.push({ alertId, shop_name: shop.shop_name, campaign: c.campaign_name, msg });
    }
  }
  return results;
}

async function checkRoiDrop(rule, shops, today, yesterday) {
  const t = requireTenant();
  const cond = JSON.parse(rule.conditions);
  const results = [];
  for (const shop of shops) {
    const todayCamp = await repos.adapter.all('SELECT * FROM ad_campaigns WHERE shop_id=? AND report_date=? AND cost>? AND tenant_id=?', [shop.id, today, cond.min_cost, t]);
    for (const tc of todayCamp) {
      const yCamp = await repos.adapter.get('SELECT * FROM ad_campaigns WHERE shop_id=? AND campaign_id=? AND report_date=? AND tenant_id=?', [shop.id, tc.campaign_id, yesterday, t]);
      if (!yCamp || !yCamp.roi || yCamp.roi <= 0) continue;
      const dropRatio = (yCamp.roi - tc.roi) / yCamp.roi;
      if (dropRatio < cond.drop_percent / 100) continue;
      if (await isInCooldown(rule.id, shop.id, tc.campaign_id, rule.cooldown_hours)) continue;
      const msg = `店铺「${shop.shop_name}」计划「${tc.campaign_name}」ROI骤降：昨日 ${yCamp.roi} → 今日 ${tc.roi}（下降 ${Math.round(dropRatio * 100)}%）`;
      const alertId = await createAlert(rule.id, shop.id, tc.campaign_id, 'roi_drop', rule.severity, `ROI骤降: ${shop.shop_name} - ${tc.campaign_name}`, msg, { yesterday_roi: yCamp.roi, today_roi: tc.roi, drop_percent: Math.round(dropRatio * 100) });
      results.push({ alertId, shop_name: shop.shop_name, campaign: tc.campaign_name, msg });
    }
  }
  return results;
}

async function checkCostOverrun(rule, shops, today) {
  const t = requireTenant();
  const cond = JSON.parse(rule.conditions);
  const results = [];
  for (const shop of shops) {
    const row = await repos.adapter.get('SELECT SUM(cost) as total_cost FROM ad_campaigns WHERE shop_id=? AND report_date=? AND tenant_id=?', [shop.id, today, t]);
    const totalCost = Number(row?.total_cost || 0);
    if (totalCost <= cond.daily_budget) continue;
    if (await isInCooldown(rule.id, shop.id, null, rule.cooldown_hours)) continue;
    const msg = `店铺「${shop.shop_name}」今日总花费 ¥${Math.round(totalCost)} 超过预算上限 ¥${cond.daily_budget}`;
    const alertId = await createAlert(rule.id, shop.id, null, 'cost_overrun', rule.severity, `花费超标: ${shop.shop_name}`, msg, { total_cost: totalCost, budget: cond.daily_budget });
    results.push({ alertId, shop_name: shop.shop_name, msg });
  }
  return results;
}

async function checkConvDrop(rule, shops, today, yesterday) {
  const t = requireTenant();
  const cond = JSON.parse(rule.conditions);
  const results = [];
  for (const shop of shops) {
    const todayR = await repos.adapter.get('SELECT * FROM daily_reports WHERE shop_id=? AND report_date=? AND tenant_id=?', [shop.id, today, t]);
    const yestR = await repos.adapter.get('SELECT * FROM daily_reports WHERE shop_id=? AND report_date=? AND tenant_id=?', [shop.id, yesterday, t]);
    if (!todayR || !yestR || !yestR.conversion_rate || yestR.conversion_rate <= 0) continue;
    const dropRatio = (yestR.conversion_rate - todayR.conversion_rate) / yestR.conversion_rate;
    if (dropRatio < cond.drop_percent / 100) continue;
    if (await isInCooldown(rule.id, shop.id, null, rule.cooldown_hours)) continue;
    const msg = `店铺「${shop.shop_name}」转化率下降：昨日 ${(yestR.conversion_rate * 100).toFixed(2)}% → 今日 ${(todayR.conversion_rate * 100).toFixed(2)}%（下降 ${Math.round(dropRatio * 100)}%）`;
    const alertId = await createAlert(rule.id, shop.id, null, 'conv_drop', rule.severity, `转化率下降: ${shop.shop_name}`, msg, { yesterday_cvr: yestR.conversion_rate, today_cvr: todayR.conversion_rate, drop_percent: Math.round(dropRatio * 100) });
    results.push({ alertId, shop_name: shop.shop_name, msg });
  }
  return results;
}

async function runAlertChecks(targetDate) {
  const t = requireTenant();
  const today = targetDate || todayLocal();
  const yesterday = dateLocalOffset(-1, new Date(today + 'T00:00:00'));
  const rules = await repos.adapter.all('SELECT * FROM alert_rules WHERE enabled=1 AND tenant_id=?', [t]);
  const allResults = [];

  for (const rule of rules) {
    const shops = await getRuleTargetShops(rule);
    if (!shops.length) continue;
    let results = [];
    switch (rule.rule_type) {
      case 'burn': results = await checkBurn(rule, shops, today); break;
      case 'roi_drop': results = await checkRoiDrop(rule, shops, today, yesterday); break;
      case 'cost_overrun': results = await checkCostOverrun(rule, shops, today); break;
      case 'conv_drop': results = await checkConvDrop(rule, shops, today, yesterday); break;
    }
    allResults.push(...results);
  }

  console.log(`[alert] 预警检测完成: ${allResults.length} 条新预警`);
  return allResults;
}

module.exports = { seedDefaultRules, runAlertChecks, getRuleTargetShops, createAlert, isInCooldown };
