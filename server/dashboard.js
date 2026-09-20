// ===== 经营看板：真实数据聚合 =====
// 数据源：daily_reports / ad_campaigns / orders_daily / refunds_daily / product_daily / products。
// 保持前端既有结构：metrics / trend / channels / ad / topProducts，并附加真实口径字段。
const { repos } = require('./repositories');
const { requireTenant } = require('./repositories/tenant-context');
const { todayLocal, dateLocalOffset, dateLocal } = require('./util');

const RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90 };
const CHANNEL_LABEL = {
  standard: ['标准推广', '#0d9488'],
  custom: ['自定义推广', '#3b82f6'],
  ai: ['智能推广', '#f59e0b'],
  search: ['搜索推广', '#0d9488'],
  display: ['展示推广', '#8b5cf6']
};

function pct(cur, prev) {
  if (!prev) return cur ? 100 : 0;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

function shopFilter(shopIds) {
  return shopIds.length ? shopIds.join(',') : '0';
}

async function sumRange(t, table, shopIds, start, end, exprs) {
  const ph = shopFilter(shopIds);
  const select = exprs.map(([alias, expr]) => `COALESCE(${expr},0) as ${alias}`).join(', ');
  return repos.adapter.get(
    `SELECT ${select} FROM ${table} WHERE tenant_id=? AND shop_id IN (${ph}) AND report_date BETWEEN ? AND ?`,
    [t, start, end]
  );
}

async function getDashboardStats({ shopIds = [], range = '30d' } = {}) {
  const t = requireTenant();
  const days = RANGE_DAYS[range] || 30;
  const end = todayLocal();
  const start = dateLocalOffset(-(days - 1));
  const prevEnd = dateLocalOffset(-days);
  const prevStart = dateLocalOffset(-(days * 2 - 1));
  const ph = shopFilter(shopIds);

  const empty = {
    metrics: { sales: 0, uv: 0, cvr: 0, roi: 0, salesChange: 0, uvChange: 0, cvrChange: 0, roiChange: 0, orders: 0, refunds: 0 },
    trend: [], channels: [], ad: { weeks: [], spend: [], output: [] }, topProducts: [], accounts: [], platforms: [],
    range, date_range: { start, end }, shop_count: 0
  };
  if (!shopIds.length) return empty;

  const [cur, curAd, prev, prevAd, curOrders, curRefunds] = await Promise.all([
    sumRange(t, 'daily_reports', shopIds, start, end, [['pay', 'SUM(pay_amount)'], ['uv', 'SUM(visitors)'], ['buyers', 'SUM(payed_buyer_count)'], ['shop_count', 'COUNT(DISTINCT shop_id)']]),
    sumRange(t, 'ad_campaigns', shopIds, start, end, [['cost', 'SUM(cost)'], ['ad_pay', 'SUM(pay_amount)']]),
    sumRange(t, 'daily_reports', shopIds, prevStart, prevEnd, [['pay', 'SUM(pay_amount)'], ['uv', 'SUM(visitors)'], ['buyers', 'SUM(payed_buyer_count)']]),
    sumRange(t, 'ad_campaigns', shopIds, prevStart, prevEnd, [['cost', 'SUM(cost)'], ['ad_pay', 'SUM(pay_amount)']]),
    sumRange(t, 'orders_daily', shopIds, start, end, [['orders', 'SUM(payed_order_count)'], ['order_pay', 'SUM(pay_amount)']]),
    sumRange(t, 'refunds_daily', shopIds, start, end, [['refunds', 'SUM(refund_count)'], ['refund_amount', 'SUM(refund_amount)']])
  ]);

  const curCvr = Number(cur.uv) > 0 ? Math.round((Number(cur.buyers) / Number(cur.uv)) * 10000) / 100 : 0;
  const prevCvr = Number(prev.uv) > 0 ? Math.round((Number(prev.buyers) / Number(prev.uv)) * 10000) / 100 : 0;
  const curRoi = Number(curAd.cost) > 0 ? Math.round((Number(curAd.ad_pay) / Number(curAd.cost)) * 100) / 100 : 0;
  const prevRoi = Number(prevAd.cost) > 0 ? Math.round((Number(prevAd.ad_pay) / Number(prevAd.cost)) * 100) / 100 : 0;

  const metrics = {
    sales: Math.round(Number(cur.pay) * 100) / 100,
    uv: Number(cur.uv),
    cvr: curCvr,
    roi: curRoi,
    salesChange: pct(Number(cur.pay), Number(prev.pay)),
    uvChange: pct(Number(cur.uv), Number(prev.uv)),
    cvrChange: Math.round((curCvr - prevCvr) * 10) / 10,
    roiChange: Math.round((curRoi - prevRoi) * 100) / 100,
    cost: Math.round(Number(curAd.cost) * 100) / 100,
    orders: Number(curOrders.orders),
    refunds: Number(curRefunds.refunds),
    refund_amount: Math.round(Number(curRefunds.refund_amount) * 100) / 100
  };

  // 趋势（按日）
  const drTrend = await repos.adapter.all(
    `SELECT report_date, SUM(pay_amount) pay, SUM(visitors) uv FROM daily_reports WHERE tenant_id=? AND shop_id IN (${ph}) AND report_date BETWEEN ? AND ? GROUP BY report_date ORDER BY report_date`,
    [t, start, end]
  );
  const adTrendRows = await repos.adapter.all(
    `SELECT report_date, SUM(cost) cost, SUM(pay_amount) ad_pay FROM ad_campaigns WHERE tenant_id=? AND shop_id IN (${ph}) AND report_date BETWEEN ? AND ? GROUP BY report_date`,
    [t, start, end]
  );
  const adMap = Object.fromEntries(adTrendRows.map(r => [r.report_date, r]));
  const drMap = Object.fromEntries(drTrend.map(r => [r.report_date, r]));
  const dates = [...new Set([...Object.keys(drMap), ...Object.keys(adMap)])].sort();
  const trend = dates.map(d => {
    const dr = drMap[d] || { pay: 0, uv: 0 };
    const ad = adMap[d] || { cost: 0, ad_pay: 0 };
    const dt = new Date(d + 'T00:00:00');
    return {
      date: `${dt.getMonth() + 1}/${dt.getDate()}`,
      date_full: d,
      sales: Math.round(Number(dr.pay) * 100) / 100,
      visitors: Number(dr.uv),
      cost: Math.round(Number(ad.cost) * 100) / 100,
      roi: Number(ad.cost) > 0 ? Math.round((Number(ad.ad_pay) / Number(ad.cost)) * 100) / 100 : 0
    };
  });

  // 渠道（按推广类型花费）
  const channelRows = await repos.adapter.all(
    `SELECT campaign_type, SUM(cost) cost FROM ad_campaigns WHERE tenant_id=? AND shop_id IN (${ph}) AND report_date BETWEEN ? AND ? GROUP BY campaign_type ORDER BY cost DESC`,
    [t, start, end]
  );
  const channels = channelRows.map(r => {
    const [name, color] = CHANNEL_LABEL[r.campaign_type] || [r.campaign_type || '其他', '#94a3b8'];
    return { name, value: Math.round(Number(r.cost) * 100) / 100, color, type: r.campaign_type || 'other' };
  });

  // 推广（按周分桶）
  const bucketCount = Math.max(1, Math.ceil(days / 7));
  const weekAgg = Array.from({ length: bucketCount }, () => ({ spend: 0, output: 0 }));
  for (const d of dates) {
    const idx = Math.min(bucketCount - 1, Math.floor((Date.parse(d) - Date.parse(start)) / 86400000 / 7));
    const ad = adMap[d] || { cost: 0, ad_pay: 0 };
    weekAgg[idx].spend += Number(ad.cost);
    weekAgg[idx].output += Number(ad.ad_pay);
  }
  const ad = {
    weeks: weekAgg.map((_, i) => `第${i + 1}周`),
    spend: weekAgg.map(w => Math.round(w.spend * 100) / 100),
    output: weekAgg.map(w => Math.round(w.output * 100) / 100)
  };

  // 商品 TOP（真实商品日报；无数据则回退广告计划成交）
  let topProducts = (await repos.adapter.all(
    `SELECT pd.product_id, MAX(p.title) title, SUM(pd.pay_amount) pay
     FROM product_daily pd
     LEFT JOIN products p ON p.shop_id=pd.shop_id AND p.product_id=pd.product_id AND p.tenant_id=pd.tenant_id
     WHERE pd.tenant_id=? AND pd.shop_id IN (${ph}) AND pd.report_date BETWEEN ? AND ?
     GROUP BY pd.product_id ORDER BY pay DESC LIMIT 10`,
    [t, start, end]
  )).map(r => ({ name: r.title || r.product_id, value: Math.round(Number(r.pay) * 100) / 100, product_id: r.product_id }));

  if (!topProducts.length) {
    topProducts = (await repos.adapter.all(
      `SELECT campaign_name name, SUM(pay_amount) pay FROM ad_campaigns WHERE tenant_id=? AND shop_id IN (${ph}) AND report_date BETWEEN ? AND ? GROUP BY campaign_name ORDER BY pay DESC LIMIT 10`,
      [t, start, end]
    )).map(r => ({ name: r.name, value: Math.round(Number(r.pay) * 100) / 100 }));
  }

  // 广告账号 / 平台表现（多平台看板：按 account_id 与 platform 聚合）
  const accountRows = await repos.adapter.all(
    `SELECT account_id, platform, SUM(cost) cost, SUM(pay_amount) pay, COUNT(DISTINCT campaign_id) campaigns
     FROM ad_campaigns
     WHERE tenant_id=? AND shop_id IN (${ph}) AND report_date BETWEEN ? AND ?
       AND account_id IS NOT NULL AND account_id <> ''
     GROUP BY account_id, platform ORDER BY cost DESC LIMIT 50`,
    [t, start, end]
  );
  const accounts = accountRows.map(r => ({
    account_id: r.account_id,
    platform: r.platform || null,
    cost: Math.round(Number(r.cost) * 100) / 100,
    pay: Math.round(Number(r.pay) * 100) / 100,
    roi: Number(r.cost) > 0 ? Math.round((Number(r.pay) / Number(r.cost)) * 100) / 100 : 0,
    campaigns: Number(r.campaigns)
  }));

  const platformRows = await repos.adapter.all(
    `SELECT platform, SUM(cost) cost, SUM(pay_amount) pay, COUNT(DISTINCT campaign_id) campaigns
     FROM ad_campaigns
     WHERE tenant_id=? AND shop_id IN (${ph}) AND report_date BETWEEN ? AND ?
     GROUP BY platform ORDER BY cost DESC`,
    [t, start, end]
  );
  const platforms = platformRows.map(r => ({
    platform: r.platform || '未标注',
    cost: Math.round(Number(r.cost) * 100) / 100,
    pay: Math.round(Number(r.pay) * 100) / 100,
    roi: Number(r.cost) > 0 ? Math.round((Number(r.pay) / Number(r.cost)) * 100) / 100 : 0,
    campaigns: Number(r.campaigns)
  }));

  return { metrics, trend, channels, ad, topProducts, accounts, platforms, range, date_range: { start, end }, shop_count: Number(cur.shop_count) };
}

module.exports = { getDashboardStats, RANGE_DAYS };
