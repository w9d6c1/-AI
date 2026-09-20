// ===== 报表生成服务 =====
// 支持：日报汇总、周报趋势、ROI分析、预警汇总、执行报告
// 输出格式：CSV / JSON；数据访问走异步仓储适配器；所有查询强制租户过滤。
const path = require('path');
const fs = require('fs');
const { repos } = require('./repositories');
const { requireTenant } = require('./repositories/tenant-context');
const { reconcileReport } = require('./reconcile');

const REPORT_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'reports');
if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });

const REPORT_TYPES = {
  daily_summary: '日报汇总',
  weekly_trend: '周报趋势',
  roi_analysis: 'ROI分析',
  alert_summary: '预警汇总',
  execution_report: '执行报告',
  reconcile_report: '执行对账'
};

function getShopIds(shopIdsJson) {
  if (!shopIdsJson) return null;
  const ids = JSON.parse(shopIdsJson);
  if (!Array.isArray(ids) || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('无效店铺范围');
  return ids;
}

function buildShopCondition(shopIdsJson) {
  const ids = getShopIds(shopIdsJson);
  if (!ids) return { clause: '', params: [] };
  if (!ids.length) return { clause: ' AND 0=1', params: [] };
  return { clause: ` AND shop_id IN (${ids.map(() => '?').join(',')})`, params: ids };
}

function csvEscape(val) {
  if (val == null) return '';
  let s = String(val);
  if (typeof val === 'string' && /^[\s]*[=+@-]/.test(s)) s = "'" + s;
  if (s.includes(',') || s.includes('"') || /[\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCSV(headers, rows) {
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) {
    lines.push(headers.map(h => csvEscape(row[h])).join(','));
  }
  return lines.join('\n');
}

// ===== 各报表类型数据查询 =====
async function queryDailySummary(dateStart, dateEnd, shopCondition) {
  const t = requireTenant();
  let sql = `SELECT s.shop_name, sg.name as group_name, dr.*
    FROM daily_reports dr
    LEFT JOIN shops s ON dr.shop_id = s.id AND s.tenant_id = dr.tenant_id
    LEFT JOIN shop_groups sg ON s.group_id = sg.id AND sg.tenant_id = dr.tenant_id
    WHERE dr.report_date BETWEEN ? AND ? AND dr.tenant_id = ?`;
  const params = [dateStart, dateEnd, t, ...shopCondition.params];
  if (shopCondition.clause) sql += shopCondition.clause.replace(/\bshop_id\b/g, 'dr.shop_id');
  return repos.adapter.all(sql, params);
}

async function queryRoiAnalysis(dateStart, dateEnd, shopCondition) {
  const t = requireTenant();
  let sql = `SELECT s.shop_name, ac.campaign_id, ac.campaign_name, ac.campaign_type,
    ac.report_date, ac.cost, ac.roi, ac.pay_amount, ac.clicks, ac.impressions, ac.ctr, ac.cpc, ac.status
    FROM ad_campaigns ac
    LEFT JOIN shops s ON ac.shop_id = s.id AND s.tenant_id = ac.tenant_id
    WHERE ac.report_date BETWEEN ? AND ? AND ac.tenant_id = ?`;
  const params = [dateStart, dateEnd, t, ...shopCondition.params];
  if (shopCondition.clause) sql += shopCondition.clause.replace(/\bshop_id\b/g, 'ac.shop_id');
  return repos.adapter.all(sql, params);
}

async function queryAlertSummary(dateStart, dateEnd, shopCondition) {
  const t = requireTenant();
  let sql = `SELECT a.*, s.shop_name
    FROM alerts a
    LEFT JOIN shops s ON a.shop_id = s.id AND s.tenant_id = a.tenant_id
    WHERE substr(a.triggered_at,1,10) BETWEEN ? AND ? AND a.tenant_id = ?`;
  const params = [dateStart, dateEnd, t, ...shopCondition.params];
  if (shopCondition.clause) sql += shopCondition.clause.replace(/\bshop_id\b/g, 'a.shop_id');
  return repos.adapter.all(sql, params);
}

async function queryExecutionReport(dateStart, dateEnd, shopCondition) {
  const t = requireTenant();
  let sql = `SELECT e.*, s.shop_name
    FROM executions e
    LEFT JOIN shops s ON e.shop_id = s.id AND s.tenant_id = e.tenant_id
    WHERE substr(e.created_at,1,10) BETWEEN ? AND ? AND e.tenant_id = ?`;
  const params = [dateStart, dateEnd, t, ...shopCondition.params];
  if (shopCondition.clause) sql += shopCondition.clause.replace(/\bshop_id\b/g, 'e.shop_id');
  return repos.adapter.all(sql, params);
}

// 生成报表
async function generateReport(reportId) {
  const t = requireTenant();
  const record = await repos.adapter.get('SELECT * FROM report_records WHERE id=? AND tenant_id=?', [reportId, t]);
  if (!record) throw new Error('报表记录不存在');

  try {
    const shopCond = buildShopCondition(record.shop_ids);
    const { date_start, date_end, report_type } = record;
    let headers, rows;

    switch (report_type) {
      case 'weekly_trend':
        rows = (await getAnalyticsOverview(date_start, date_end, record.shop_ids)).trend;
        headers = ['report_date', 'pay', 'cost', 'uv', 'roi'];
        break;
      case 'daily_summary':
        rows = await queryDailySummary(date_start, date_end, shopCond);
        headers = ['shop_name', 'group_name', 'report_date', 'visitors', 'payed_buyer_count', 'pay_amount', 'pay_item_count', 'conversion_rate', 'avg_unit_price'];
        break;
      case 'roi_analysis':
        rows = await queryRoiAnalysis(date_start, date_end, shopCond);
        headers = ['shop_name', 'campaign_id', 'campaign_name', 'campaign_type', 'report_date', 'cost', 'roi', 'pay_amount', 'clicks', 'impressions', 'ctr', 'cpc', 'status'];
        break;
      case 'alert_summary':
        rows = await queryAlertSummary(date_start, date_end, shopCond);
        headers = ['id', 'shop_name', 'alert_type', 'severity', 'title', 'message', 'status', 'triggered_at'];
        break;
      case 'execution_report':
        rows = await queryExecutionReport(date_start, date_end, shopCond);
        headers = ['id', 'shop_name', 'action_type', 'target_campaign_id', 'status', 'error_msg', 'created_at', 'finished_at'];
        break;
      case 'reconcile_report': {
        let ids = getShopIds(record.shop_ids);
        if (!ids) ids = (await repos.adapter.all('SELECT id FROM shops WHERE tenant_id=?', [t])).map(r => r.id);
        const rep = await reconcileReport({ shopIds: ids, dateStart: date_start, dateEnd: date_end + ' 23:59:59' });
        rows = rep.rows;
        headers = ['id', 'shop_name', 'action_type', 'target_campaign_id', 'expected_value', 'before_value', 'actual_value', 'diff', 'matched', 'status', 'is_auto', 'finished_at', 'created_at'];
        break;
      }
      default:
        throw new Error(`未知报表类型: ${report_type}`);
    }

    const fileFormat = record.file_format || 'csv';
    if (!['csv', 'json'].includes(fileFormat)) throw new Error('不支持的文件格式');
    const fileName = `report_${record.id}.${fileFormat}`;
    const filePath = path.join(REPORT_DIR, fileName);
    let fileContent;

    if (fileFormat === 'json') {
      fileContent = JSON.stringify({ report_type, date_range: { start: date_start, end: date_end }, total_rows: rows.length, rows }, null, 2);
    } else {
      fileContent = '\ufeff' + rowsToCSV(headers, rows);
    }

    fs.writeFileSync(filePath, fileContent, 'utf-8');
    const stats = fs.statSync(filePath);

    await repos.adapter.run('UPDATE report_records SET status=?, file_path=?, file_size=?, row_count=?, error_msg=NULL WHERE id=? AND tenant_id=?',
      ['completed', fileName, stats.size, rows.length, reportId, t]);

    return { filePath, fileName, rowCount: rows.length, fileSize: stats.size };
  } catch (e) {
    await repos.adapter.run('UPDATE report_records SET status=?, error_msg=? WHERE id=? AND tenant_id=?', ['failed', e.message, reportId, t]);
    throw e;
  }
}

// 获取分析概览数据（前端看板用）
async function getAnalyticsOverview(dateStart, dateEnd, shopIdsJson) {
  const t = requireTenant();
  const shopCond = buildShopCondition(shopIdsJson);
  const params = [dateStart, dateEnd, t, ...shopCond.params];

  let sql1 = `SELECT COUNT(DISTINCT shop_id) as shop_count, SUM(pay_amount) as total_pay, SUM(visitors) as total_uv, CASE WHEN SUM(visitors)>0 THEN 100.0*SUM(payed_buyer_count)/SUM(visitors) ELSE 0 END as avg_cvr FROM daily_reports WHERE report_date BETWEEN ? AND ? AND tenant_id = ?`;
  if (shopCond.clause) sql1 += shopCond.clause;
  const dr = (await repos.adapter.get(sql1, params)) || {};

  let sqlAd = `SELECT SUM(cost) as total_cost, SUM(pay_amount) as total_ad_pay FROM ad_campaigns WHERE report_date BETWEEN ? AND ? AND tenant_id = ?`;
  if (shopCond.clause) sqlAd += shopCond.clause;
  const ad = (await repos.adapter.get(sqlAd, params)) || {};
  const totalCost = Number(ad.total_cost || 0);
  const totalAdPay = Number(ad.total_ad_pay || 0);

  let sqlOrd = `SELECT COALESCE(SUM(payed_order_count),0) orders, COALESCE(SUM(refund_amount),0) refund_amount FROM orders_daily WHERE report_date BETWEEN ? AND ? AND tenant_id = ?`;
  if (shopCond.clause) sqlOrd += shopCond.clause;
  const ord = (await repos.adapter.get(sqlOrd, params)) || {};

  let sqlRef = `SELECT COALESCE(SUM(refund_count),0) refunds, COALESCE(SUM(refund_amount),0) refund_amount FROM refunds_daily WHERE report_date BETWEEN ? AND ? AND tenant_id = ?`;
  if (shopCond.clause) sqlRef += shopCond.clause;
  const ref = (await repos.adapter.get(sqlRef, params)) || {};

  const summary = {
    shop_count: Number(dr.shop_count || 0),
    total_pay: Number(dr.total_pay || 0),
    total_cost: totalCost,
    avg_roi: totalCost > 0 ? Math.round((totalAdPay / totalCost) * 100) / 100 : 0,
    total_uv: Number(dr.total_uv || 0),
    avg_cvr: Number(dr.avg_cvr || 0),
    total_orders: Number(ord.orders || 0),
    total_refunds: Number(ref.refunds || 0),
    refund_amount: Math.round((Number(ord.refund_amount || 0) + Number(ref.refund_amount || 0)) * 100) / 100
  };

  let sql2 = `SELECT report_date, SUM(pay_amount) as pay, SUM(visitors) as uv FROM daily_reports WHERE report_date BETWEEN ? AND ? AND tenant_id = ?`;
  if (shopCond.clause) sql2 += shopCond.clause;
  sql2 += ' GROUP BY report_date ORDER BY report_date';
  const drTrend = await repos.adapter.all(sql2, params);

  let sql2ad = `SELECT report_date, SUM(cost) as cost, SUM(pay_amount) as ad_pay FROM ad_campaigns WHERE report_date BETWEEN ? AND ? AND tenant_id = ?`;
  if (shopCond.clause) sql2ad += shopCond.clause;
  sql2ad += ' GROUP BY report_date ORDER BY report_date';
  const adMap = {};
  (await repos.adapter.all(sql2ad, params)).forEach(a => { adMap[a.report_date] = a; });

  const drMap = Object.fromEntries(drTrend.map(t => [t.report_date, t]));
  const trend = [...new Set([...Object.keys(drMap), ...Object.keys(adMap)])].sort().map(date => {
    const tr = drMap[date] || { report_date: date, pay: 0, uv: 0 };
    const a = adMap[tr.report_date] || { cost: 0, ad_pay: 0 };
    return {
      report_date: tr.report_date,
      pay: Number(tr.pay || 0),
      cost: Number(a.cost || 0),
      uv: Number(tr.uv || 0),
      roi: a.cost > 0 ? Math.round((a.ad_pay / a.cost) * 100) / 100 : 0
    };
  });

  let sql3 = `SELECT dr.shop_id, s.shop_name, SUM(dr.pay_amount) as pay, SUM(dr.visitors) as uv FROM daily_reports dr LEFT JOIN shops s ON dr.shop_id=s.id AND s.tenant_id=dr.tenant_id WHERE dr.report_date BETWEEN ? AND ? AND dr.tenant_id = ?`;
  if (shopCond.clause) sql3 += shopCond.clause.replace(/\bshop_id\b/g, 'dr.shop_id');
  sql3 += ' GROUP BY dr.shop_id, s.shop_name ORDER BY pay DESC LIMIT 20';
  const topBase = await repos.adapter.all(sql3, params);

  let sql3ad = `SELECT shop_id, SUM(cost) as cost, SUM(pay_amount) as ad_pay FROM ad_campaigns WHERE report_date BETWEEN ? AND ? AND tenant_id = ?`;
  if (shopCond.clause) sql3ad += shopCond.clause;
  sql3ad += ' GROUP BY shop_id';
  const shopAd = {};
  (await repos.adapter.all(sql3ad, params)).forEach(a => { shopAd[a.shop_id] = a; });

  const topShops = topBase.map(s => {
    const a = shopAd[s.shop_id] || { cost: 0, ad_pay: 0 };
    return {
      shop_name: s.shop_name,
      pay: Number(s.pay || 0),
      cost: Number(a.cost || 0),
      roi: a.cost > 0 ? Math.round((a.ad_pay / a.cost) * 100) / 100 : 0
    };
  });

  return { summary, trend, topShops };
}

module.exports = { generateReport, getAnalyticsOverview, REPORT_TYPES, REPORT_DIR };
