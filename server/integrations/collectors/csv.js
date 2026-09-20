// ===== CSV 导入采集器 =====
// 契约（Collector）：{ id, platform, pull(ctx), normalize(raw) }
//   pull(ctx)      -> 解析 CSV 文本为原始记录
//   normalize(raw) -> { type, rows, dailyReports?, campaigns? }
// 另提供 importBuffer()：在租户上下文内完成校验+质量检查+入库+导入报告。
// 支持类型：daily_report / ad_campaign / product / product_daily / orders_daily / refunds_daily。
const { repos } = require('../../repositories');
const { upsertSql } = require('../../repositories/sql');
const { requireTenant } = require('../../repositories/tenant-context');
const { nowLocal } = require('../../util');
const { parseCsv, toCsv } = require('../../csv');

const F = {
  shop: { key: 'shop_qianniu_account', label: '千牛账号', required: true },
  date: { key: 'report_date', label: '日期', required: true, type: 'date' },
  platform: { key: 'platform', label: '平台' }
};

const FIELD_DEFS = {
  daily_report: [
    F.shop, F.date,
    { key: 'visitors', label: '访客数', type: 'int' },
    { key: 'payed_buyer_count', label: '支付买家数', type: 'int' },
    { key: 'pay_amount', label: '支付金额', type: 'num' },
    { key: 'pay_item_count', label: '支付件数', type: 'int' },
    { key: 'conversion_rate', label: '转化率', type: 'num' },
    { key: 'avg_unit_price', label: '客单价', type: 'num' }
  ],
  ad_campaign: [
    F.shop, F.date,
    { key: 'campaign_id', label: '计划ID', required: true },
    { key: 'campaign_name', label: '计划名称', required: true },
    { key: 'campaign_type', label: '计划类型' },
    { key: 'account_id', label: '广告账号' },
    { key: 'cost', label: '花费', required: true, type: 'num' },
    { key: 'impressions', label: '展现量', required: true, type: 'int' },
    { key: 'clicks', label: '点击量', required: true, type: 'int' },
    { key: 'ctr', label: '点击率', type: 'num' },
    { key: 'cpc', label: '平均点击花费', type: 'num' },
    { key: 'pay_amount', label: '成交金额', type: 'num' },
    { key: 'roi', label: 'ROI', type: 'num' },
    { key: 'status', label: '状态' },
    F.platform
  ],
  product: [
    F.shop,
    { key: 'product_id', label: '商品ID', required: true },
    { key: 'title', label: '商品标题' },
    { key: 'category', label: '类目' },
    { key: 'price', label: '价格', type: 'num' },
    { key: 'status', label: '状态' },
    F.platform
  ],
  product_daily: [
    F.shop,
    { key: 'product_id', label: '商品ID', required: true },
    F.date,
    { key: 'visitors', label: '访客数', type: 'int' },
    { key: 'payed_buyer_count', label: '支付买家数', type: 'int' },
    { key: 'pay_amount', label: '支付金额', type: 'num' },
    { key: 'pay_item_count', label: '支付件数', type: 'int' },
    { key: 'refund_amount', label: '退款金额', type: 'num' },
    { key: 'refund_count', label: '退款笔数', type: 'int' },
    { key: 'conversion_rate', label: '转化率', type: 'num' },
    { key: 'avg_unit_price', label: '客单价', type: 'num' },
    F.platform
  ],
  orders_daily: [
    F.shop, F.date,
    { key: 'order_count', label: '订单数', type: 'int' },
    { key: 'payed_order_count', label: '支付订单数', type: 'int' },
    { key: 'payed_buyer_count', label: '支付买家数', type: 'int' },
    { key: 'pay_amount', label: '支付金额', type: 'num' },
    { key: 'refund_order_count', label: '退款订单数', type: 'int' },
    { key: 'refund_amount', label: '退款金额', type: 'num' },
    { key: 'new_buyer_count', label: '新买家数', type: 'int' },
    { key: 'old_buyer_count', label: '老买家数', type: 'int' },
    F.platform
  ],
  refunds_daily: [
    F.shop, F.date,
    { key: 'refund_count', label: '退款笔数', type: 'int' },
    { key: 'refund_amount', label: '退款金额', type: 'num' },
    { key: 'refund_item_count', label: '退款件数', type: 'int' },
    { key: 'refund_rate', label: '退款率', type: 'num' },
    { key: 'reason_top', label: '主要退款原因' },
    F.platform
  ]
};

// 每类型的落库信息
const SPECS = {
  daily_report: { table: 'daily_reports', conflict: ['shop_id', 'report_date'], hasPlatform: false, tsColumn: 'collected_at', fields: FIELD_DEFS.daily_report },
  ad_campaign: { table: 'ad_campaigns', conflict: ['shop_id', 'campaign_id', 'report_date'], hasPlatform: true, tsColumn: 'collected_at', fields: FIELD_DEFS.ad_campaign },
  product: { table: 'products', conflict: ['tenant_id', 'shop_id', 'product_id'], hasPlatform: true, tsColumn: 'updated_at', fields: FIELD_DEFS.product },
  product_daily: { table: 'product_daily', conflict: ['tenant_id', 'shop_id', 'product_id', 'report_date'], hasPlatform: true, tsColumn: 'collected_at', fields: FIELD_DEFS.product_daily },
  orders_daily: { table: 'orders_daily', conflict: ['tenant_id', 'shop_id', 'report_date'], hasPlatform: true, tsColumn: 'collected_at', fields: FIELD_DEFS.orders_daily },
  refunds_daily: { table: 'refunds_daily', conflict: ['tenant_id', 'shop_id', 'report_date'], hasPlatform: true, tsColumn: 'collected_at', fields: FIELD_DEFS.refunds_daily }
};

const TYPE_NAMES = Object.keys(SPECS);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDate(v) {
  if (!DATE_RE.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

// 依据表头自动识别记录类型（兼容中文标签模板与英文字段名）
function detectType(headers) {
  const set = new Set((headers || []).map(h => String(h).trim()));
  const has = (...names) => names.some(n => set.has(n));
  const productId = has('product_id', '商品ID');
  const reportDate = has('report_date', '日期');
  if (has('campaign_id', '计划ID')) return 'ad_campaign';
  if (productId && reportDate) return 'product_daily';
  if (productId) return 'product';
  if (has('order_count', '订单数', 'payed_order_count', '支付订单数')) return 'orders_daily';
  if (has('refund_count', '退款笔数', 'refund_amount', '退款金额') && !has('visitors', '访客数')) return 'refunds_daily';
  if (has('visitors', '访客数', 'pay_amount', '支付金额')) return 'daily_report';
  return null;
}

// 字段别名：英文 key 与中文 label 都映射到 key
function fieldAlias(type) {
  const map = new Map();
  const spec = SPECS[type];
  if (!spec) return map;
  for (const f of spec.fields) {
    map.set(f.key, f.key);
    map.set(f.label, f.key);
  }
  return map;
}

// Collector.pull：CSV 文本 -> 原始记录
function pull(ctx = {}) {
  const text = Buffer.isBuffer(ctx.buffer) ? ctx.buffer.toString('utf8') : String(ctx.buffer ?? '');
  const { headers, records } = parseCsv(text);
  const type = ctx.type && ctx.type !== 'auto' ? ctx.type : detectType(headers);
  const alias = fieldAlias(type);
  const mapped = alias.size
    ? records.map(rec => {
        const obj = { __row: rec.__row };
        for (const [k, v] of Object.entries(rec)) {
          if (k === '__row') continue;
          obj[alias.get(String(k).trim()) || k] = v;
        }
        return obj;
      })
    : records;
  return { headers, records: mapped, type };
}

// 结构校验（不查库）：返回 [{ row, field, message }]
function validateRecords(records, type) {
  const spec = SPECS[type];
  if (!spec) return [{ row: 0, field: 'type', message: '无法识别导入类型（表头需包含 campaign_id / product_id / visitors / order_count / refund_count 之一）' }];
  const errors = [];
  records.forEach((rec, i) => {
    const row = rec.__row || i + 2;
    for (const f of spec.fields) {
      const raw = rec[f.key];
      const empty = raw === undefined || raw === null || raw === '';
      if (f.required && empty) { errors.push({ row, field: f.key, message: `${f.label}不能为空` }); continue; }
      if (empty) continue;
      if (f.type === 'date' && !isDate(raw)) errors.push({ row, field: f.key, message: `${f.label}须为 YYYY-MM-DD` });
      if (f.type === 'int' && !/^-?\d+$/.test(raw)) errors.push({ row, field: f.key, message: `${f.label}须为整数` });
      if (f.type === 'num' && !Number.isFinite(Number(raw))) errors.push({ row, field: f.key, message: `${f.label}须为数字` });
    }
  });
  return errors;
}

// 数据质量检查（非阻断）：返回 [{ row, field, message }]
const NON_NEGATIVE = new Set(['visitors', 'payed_buyer_count', 'pay_amount', 'pay_item_count', 'cost', 'impressions', 'clicks', 'price', 'order_count', 'payed_order_count', 'refund_count', 'refund_amount', 'refund_item_count', 'refund_order_count', 'new_buyer_count', 'old_buyer_count']);
const RATIO_FIELDS = new Set(['conversion_rate', 'ctr', 'refund_rate']);

function qualityCheck(type, records) {
  const spec = SPECS[type];
  if (!spec) return [];
  const warnings = [];
  records.forEach((rec, i) => {
    const row = rec.__row || i + 2;
    for (const f of spec.fields) {
      if (!f.type || f.type === 'date') continue;
      const raw = rec[f.key];
      if (raw === undefined || raw === '') continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      if (NON_NEGATIVE.has(f.key) && n < 0) warnings.push({ row, field: f.key, message: `${f.label}为负值` });
      if (RATIO_FIELDS.has(f.key) && n > 1) warnings.push({ row, field: f.key, message: `${f.label}大于 1，疑似百分比未换算（应填 0.03 而非 3）` });
    }
    if (rec.impressions !== undefined && rec.impressions !== '' && rec.clicks !== undefined && rec.clicks !== '' &&
        Number(rec.clicks) > Number(rec.impressions)) {
      warnings.push({ row, field: 'clicks', message: '点击量大于展现量' });
    }
  });
  return warnings;
}

function convert(f, v) {
  if (v === '' || v === undefined || v === null) return null;
  if (f.type === 'int') return parseInt(v, 10);
  if (f.type === 'num') return Number(v);
  return String(v);
}

function rawOf(spec, rec) {
  const raw = {};
  for (const f of spec.fields) raw[f.key] = rec[f.key] ?? null;
  return raw;
}

// 原始记录 -> 落库行（含 tenant_id/shop_id/platform/raw_json/时间戳）
function buildRow(spec, rec, shop, platform, ts) {
  const cols = ['tenant_id', 'shop_id'];
  const vals = [shop.tenantId, shop.id];
  if (spec.hasPlatform) { cols.push('platform'); vals.push(platform); }
  for (const f of spec.fields) {
    if (f.key === 'shop_qianniu_account' || f.key === 'platform') continue;
    cols.push(f.key);
    vals.push(convert(f, rec[f.key]));
  }
  cols.push('raw_json');
  vals.push(JSON.stringify(rawOf(spec, rec)));
  cols.push(spec.tsColumn);
  vals.push(ts);
  return { cols, vals };
}

// Collector.normalize：原始记录 -> 领域结构
function normalize(raw) {
  const type = raw.type;
  const records = raw.records || [];
  const spec = SPECS[type];
  const out = { type, rows: [], dailyReports: [], campaigns: [] };
  if (!spec) return out;
  out.rows = records.map(rec => {
    const o = {};
    for (const f of spec.fields) if (f.key !== 'shop_qianniu_account') o[f.key] = convert(f, rec[f.key]);
    o.shop_qianniu_account = rec.shop_qianniu_account;
    return o;
  });
  if (type === 'daily_report') out.dailyReports = out.rows;
  if (type === 'ad_campaign') out.campaigns = out.rows;
  return out;
}

// 在租户上下文内执行导入，写 import_batches 报告（含去重计数与质量告警）
async function importBuffer(ctx = {}) {
  const t = requireTenant();
  const fileName = ctx.fileName || null;
  const parsed = pull(ctx);
  const total = parsed.records.length;
  const info = await repos.adapter.run(
    'INSERT INTO import_batches (tenant_id, source, file_name, status, total_rows, created_by) VALUES (?,?,?,?,?,?)',
    [t, 'csv', fileName, 'running', total, ctx.userId || null]
  );
  const batchId = info.lastInsertRowid;

  const errors = validateRecords(parsed.records, parsed.type);
  if (errors.length) {
    await repos.adapter.run(
      'UPDATE import_batches SET status=?, failed_rows=?, errors_json=?, summary_json=?, finished_at=? WHERE id=? AND tenant_id=?',
      ['failed', total, JSON.stringify(errors.slice(0, 200)), JSON.stringify({ type: parsed.type, errors: errors.length }), nowLocal(), batchId, t]
    );
    return { batchId, status: 'failed', type: parsed.type, total, success: 0, failed: total, inserted: 0, updated: 0, errors: errors.slice(0, 200), warnings: [] };
  }

  const spec = SPECS[parsed.type];
  const shops = await repos.adapter.all('SELECT id, qianniu_account, platform FROM shops WHERE tenant_id=?', [t]);
  const shopMap = new Map(shops.map(s => [String(s.qianniu_account), s]));

  const ts = nowLocal();
  let inserted = 0;
  let updated = 0;
  const rowErrors = [];
  const warnings = qualityCheck(parsed.type, parsed.records);

  for (const rec of parsed.records) {
    const row = rec.__row || 0;
    const shop = shopMap.get(String(rec.shop_qianniu_account));
    if (!shop) { rowErrors.push({ row, field: 'shop_qianniu_account', message: `未找到千牛账号 ${rec.shop_qianniu_account} 对应店铺` }); continue; }
    const platform = rec.platform || shop.platform || 'taobao';
    const built = buildRow(spec, rec, { id: shop.id, tenantId: t }, platform, ts);

    // 去重计数：冲突键已存在则计为 updated，否则 inserted
    const whereCols = [...new Set(['tenant_id', ...spec.conflict])];
    const existing = await repos.adapter.get(
      `SELECT id FROM ${spec.table} WHERE ${whereCols.map(c => `${c}=?`).join(' AND ')}`,
      whereCols.map(c => built.cols.includes(c) ? built.vals[built.cols.indexOf(c)] : null)
    );

    const sql = upsertSql(repos.adapter.dialect, spec.table, built.cols, spec.conflict, built.cols.filter(c => !spec.conflict.includes(c)));
    await repos.adapter.run(sql, built.vals);
    if (existing) updated++; else inserted++;
  }

  const failed = total - inserted - updated;
  const status = failed === 0 ? 'success' : ((inserted + updated) === 0 ? 'failed' : 'partial');
  const summary = { type: parsed.type, inserted, updated, shops_matched: new Set(parsed.records.map(r => r.shop_qianniu_account)).size, errors: rowErrors.length, warnings: warnings.length };
  await repos.adapter.run(
    'UPDATE import_batches SET status=?, success_rows=?, failed_rows=?, errors_json=?, warnings_json=?, summary_json=?, finished_at=? WHERE id=? AND tenant_id=?',
    [status, inserted + updated, failed, rowErrors.length ? JSON.stringify(rowErrors.slice(0, 200)) : null, warnings.length ? JSON.stringify(warnings.slice(0, 200)) : null, JSON.stringify(summary), nowLocal(), batchId, t]
  );
  return { batchId, status, type: parsed.type, total, success: inserted + updated, failed, inserted, updated, errors: rowErrors.slice(0, 200), warnings: warnings.slice(0, 200), summary };
}

// 模板：表头 + 一行示例
const SAMPLES = {
  daily_report: { shop_qianniu_account: 'qianniu_demo', report_date: '2026-09-20', visitors: 1200, payed_buyer_count: 36, pay_amount: 3600, pay_item_count: 42, conversion_rate: 0.03, avg_unit_price: 100 },
  ad_campaign: { shop_qianniu_account: 'qianniu_demo', report_date: '2026-09-20', campaign_id: 'c_1001', campaign_name: '爆款推广', campaign_type: 'standard', account_id: 'acct_01', cost: 300, impressions: 12000, clicks: 240, ctr: 0.02, cpc: 1.25, pay_amount: 1500, roi: 5, status: 'running', platform: 'taobao' },
  product: { shop_qianniu_account: 'qianniu_demo', product_id: 'p_1001', title: '示例商品', category: '女装', price: 99, status: 'on_sale', platform: 'taobao' },
  product_daily: { shop_qianniu_account: 'qianniu_demo', product_id: 'p_1001', report_date: '2026-09-20', visitors: 800, payed_buyer_count: 20, pay_amount: 2000, pay_item_count: 24, refund_amount: 50, refund_count: 1, conversion_rate: 0.025, avg_unit_price: 100, platform: 'taobao' },
  orders_daily: { shop_qianniu_account: 'qianniu_demo', report_date: '2026-09-20', order_count: 60, payed_order_count: 45, payed_buyer_count: 36, pay_amount: 3600, refund_order_count: 2, refund_amount: 100, new_buyer_count: 20, old_buyer_count: 16, platform: 'taobao' },
  refunds_daily: { shop_qianniu_account: 'qianniu_demo', report_date: '2026-09-20', refund_count: 3, refund_amount: 150, refund_item_count: 4, refund_rate: 0.02, reason_top: '尺码不符', platform: 'taobao' }
};

function template(type) {
  const spec = SPECS[type];
  if (!spec) throw new Error('不支持的导入类型');
  return toCsv([SAMPLES[type]], spec.fields);
}

const TYPE_LABELS = {
  daily_report: '店铺日报',
  ad_campaign: '广告计划',
  product: '商品',
  product_daily: '商品日报',
  orders_daily: '订单日报',
  refunds_daily: '退款日报'
};

function types() {
  return TYPE_NAMES.map(value => ({ value, label: TYPE_LABELS[value] || value }));
}

module.exports = {
  id: 'csv',
  platform: 'csv',
  SPECS,
  types,
  pull,
  normalize,
  validateRecords,
  qualityCheck,
  detectType,
  importBuffer,
  template
};
