// ===== 多店铺管理路由：店铺/看板/建议/执行/RPA回调/审计 =====
const express = require('express');
const multer = require('multer');
const { repos } = require('../repositories');
const { requireTenant } = require('../repositories/tenant-context');
const { upsertSql, dayPrefix } = require('../repositories/sql');
const { authRequired, asyncH, requireRole } = require('../middleware');
const { getAccessibleShopIds } = require('../access');
const { enforceShopQuota } = require('../quota');
const { triggerCollection, MOCK_MODE } = require('../rpa');
const { enqueue, enabled: queueEnabled } = require('../queue');
const { generateSuggestions } = require('../suggestion');
const { runAlertChecks } = require('../alert');
const { todayLocal, dateLocalOffset, mapLimit, concurrency, nowLocal } = require('../util');
const { toCsv, parseCsv } = require('../csv');
const { signFile } = require('../files');
const executionService = require('../execution-service');
const { reconcileReport } = require('../reconcile');
const { toSpreadsheetML } = require('../xlsx');

const router = express.Router();
router.use(authRequired);

// CSV 上传（批量回填）
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (String(file.originalname || '').toLowerCase().endsWith('.csv')) return cb(null, true);
    cb(Object.assign(new Error('仅支持 .csv 文件'), { status: 400 }));
  }
});

const FULL_ACCESS_ROLES = ['boss', 'admin'];
const BURN_COST_THRESHOLD = 100;
const BURN_ROI_THRESHOLD = 1.0;
const MAX_ADJUST_RATIO = 0.3;

async function logAudit(userId, shopId, action, targetType, targetId, detail, ip) {
  await repos.adapter.run(
    'INSERT INTO audit_logs (tenant_id, user_id, shop_id, action, target_type, target_id, detail_json, ip_address) VALUES (?,?,?,?,?,?,?,?)',
    [requireTenant(), userId || null, shopId || null, action, targetType || null, targetId ? String(targetId) : null, detail ? JSON.stringify(detail) : null, ip || null]
  );
}

// ========== 店铺管理 ==========
router.get('/shops', asyncH(async (req, res) => {
  const t = requireTenant();
  const shopIds = await getAccessibleShopIds(req.user);
  const params = [t];
  let platformFilter = '';
  if (req.query.platform) { platformFilter = ' AND s.platform=?'; params.push(req.query.platform); }
  const shops = await repos.adapter.all(`
    SELECT s.*, sg.name as group_name, sg.batch_no
    FROM shops s LEFT JOIN shop_groups sg ON s.group_id = sg.id AND sg.tenant_id = s.tenant_id
    WHERE s.tenant_id = ? AND s.id IN (${shopIds.length ? shopIds.join(',') : '0'})${platformFilter}
    ORDER BY s.id
  `, params);
  res.json({ shops });
}));

router.post('/shops', asyncH(async (req, res) => {
  if (!FULL_ACCESS_ROLES.includes(req.user.role || 'member')) return res.status(403).json({ error: '仅管理员可添加店铺' });
  const t = requireTenant();
  const { shop_name, wangwang_id, qianniu_account, rpa_robot_id, group_id, daily_adjust_limit, platform } = req.body;
  if (!shop_name || !qianniu_account) return res.status(400).json({ error: '店铺名称和千牛账号不能为空' });
  await enforceShopQuota();
  const info = await repos.adapter.run(
    'INSERT INTO shops (tenant_id, shop_name, wangwang_id, qianniu_account, rpa_robot_id, group_id, daily_adjust_limit, platform) VALUES (?,?,?,?,?,?,?,?)',
    [t, shop_name, wangwang_id || null, qianniu_account, rpa_robot_id || null, group_id || null, daily_adjust_limit || 5, platform || 'taobao']
  );
  await logAudit(req.user.id, null, 'config_change', 'shop', info.lastInsertRowid, { action: 'create', shop_name, platform: platform || 'taobao' }, req.ip);
  res.json({ shop: await repos.adapter.get('SELECT * FROM shops WHERE id=? AND tenant_id=?', [info.lastInsertRowid, t]) });
}));

router.put('/shops/:id', asyncH(async (req, res) => {
  if (!FULL_ACCESS_ROLES.includes(req.user.role || 'member')) return res.status(403).json({ error: '仅管理员可修改店铺' });
  const t = requireTenant();
  const shop = await repos.adapter.get('SELECT * FROM shops WHERE id=? AND tenant_id=?', [req.params.id, t]);
  if (!shop) return res.status(404).json({ error: '店铺不存在' });
  const { shop_name, wangwang_id, qianniu_account, rpa_robot_id, group_id, daily_adjust_limit, platform } = req.body;
  await repos.adapter.run(
    'UPDATE shops SET shop_name=?, wangwang_id=?, qianniu_account=?, rpa_robot_id=?, group_id=?, daily_adjust_limit=?, platform=? WHERE id=? AND tenant_id=?',
    [shop_name ?? shop.shop_name, wangwang_id ?? shop.wangwang_id, qianniu_account ?? shop.qianniu_account, rpa_robot_id ?? shop.rpa_robot_id, group_id ?? shop.group_id, daily_adjust_limit ?? shop.daily_adjust_limit, platform ?? shop.platform, req.params.id, t]
  );
  res.json({ shop: await repos.adapter.get('SELECT * FROM shops WHERE id=? AND tenant_id=?', [req.params.id, t]) });
}));

router.patch('/shops/:id/status', asyncH(async (req, res) => {
  if (!FULL_ACCESS_ROLES.includes(req.user.role || 'member')) return res.status(403).json({ error: '仅管理员可修改店铺状态' });
  const t = requireTenant();
  const { status } = req.body;
  await repos.adapter.run('UPDATE shops SET status=? WHERE id=? AND tenant_id=?', [status, req.params.id, t]);
  await logAudit(req.user.id, Number(req.params.id), 'config_change', 'shop', req.params.id, { action: 'status_change', status }, req.ip);
  res.json({ ok: true });
}));

// ========== 店铺看板 ==========
router.get('/stores/dashboard', asyncH(async (req, res) => {
  const t = requireTenant();
  const shopIds = await getAccessibleShopIds(req.user);
  if (!shopIds.length) return res.json({ total_pay: 0, total_cost: 0, overall_roi: 0, total_visitors: 0, shops: [], alerts: [] });

  const today = todayLocal();
  const yesterday = dateLocalOffset(-1);

  // 多平台筛选：先按 platform 过滤店铺，再用过滤后的店铺范围聚合
  const platform = req.query.platform;
  const shopParams = [t];
  let shopPlatformFilter = '';
  if (platform) { shopPlatformFilter = ' AND platform=?'; shopParams.push(platform); }
  const shops = await repos.adapter.all(`SELECT * FROM shops WHERE tenant_id=? AND id IN (${shopIds.join(',')})${shopPlatformFilter}`, shopParams);
  if (!shops.length) return res.json({ total_pay: 0, total_cost: 0, overall_roi: 0, total_visitors: 0, shops: [], alerts: [] });
  const ph = shops.map(s => s.id).join(',');

  const todayReports = await repos.adapter.all(`SELECT * FROM daily_reports WHERE tenant_id=? AND shop_id IN (${ph}) AND report_date=?`, [t, today]);
  const todayCampaigns = await repos.adapter.all(`SELECT * FROM ad_campaigns WHERE tenant_id=? AND shop_id IN (${ph}) AND report_date=?`, [t, today]);
  const yReports = await repos.adapter.all(`SELECT * FROM daily_reports WHERE tenant_id=? AND shop_id IN (${ph}) AND report_date=?`, [t, yesterday]);
  const yCampaigns = await repos.adapter.all(`SELECT * FROM ad_campaigns WHERE tenant_id=? AND shop_id IN (${ph}) AND report_date=?`, [t, yesterday]);

  const aggToday = {}, aggYest = {};
  todayReports.forEach(r => { aggToday[r.shop_id] = { visitors: r.visitors || 0, pay: r.pay_amount || 0, cost: 0 }; });
  todayCampaigns.forEach(c => { if (!aggToday[c.shop_id]) aggToday[c.shop_id] = { visitors: 0, pay: 0, cost: 0 }; aggToday[c.shop_id].cost += c.cost || 0; });
  yReports.forEach(r => { aggYest[r.shop_id] = { visitors: r.visitors || 0, pay: r.pay_amount || 0, cost: 0 }; });
  yCampaigns.forEach(c => { if (!aggYest[c.shop_id]) aggYest[c.shop_id] = { visitors: 0, pay: 0, cost: 0 }; aggYest[c.shop_id].cost += c.cost || 0; });

  let totalPay = 0, totalCost = 0, totalVisitors = 0, yTotalPay = 0, yTotalCost = 0;
  const shopList = shops.map(s => {
    const tt = aggToday[s.id] || { visitors: 0, pay: 0, cost: 0 };
    const y = aggYest[s.id] || { visitors: 0, pay: 0, cost: 0 };
    totalPay += tt.pay; totalCost += tt.cost; totalVisitors += tt.visitors;
    yTotalPay += y.pay; yTotalCost += y.cost;
    return {
      shop_id: s.id, shop_name: s.shop_name,
      today_pay_amount: tt.pay || null, today_cost: tt.cost || null,
      today_roi: tt.cost > 0 ? Math.round((tt.pay / tt.cost) * 100) / 100 : null,
      today_visitors: tt.visitors || null,
      yesterday_pay_amount: y.pay || null, yesterday_cost: y.cost || null,
      yesterday_roi: y.cost > 0 ? Math.round((y.pay / y.cost) * 100) / 100 : null
    };
  });

  const alerts = (await repos.adapter.all(
    `SELECT ac.*, s.shop_name FROM ad_campaigns ac JOIN shops s ON ac.shop_id=s.id AND s.tenant_id=ac.tenant_id WHERE ac.tenant_id=? AND ac.shop_id IN (${ph}) AND ac.report_date=? AND ac.cost>? AND ac.roi<?`,
    [t, today, BURN_COST_THRESHOLD, BURN_ROI_THRESHOLD]
  )).map(a => ({ shop_id: a.shop_id, shop_name: a.shop_name, campaign_id: a.campaign_id, campaign_name: a.campaign_name, cost: a.cost, roi: a.roi, report_date: a.report_date }));

  res.json({
    total_pay: Math.round(totalPay * 100) / 100,
    total_cost: Math.round(totalCost * 100) / 100,
    overall_roi: totalCost > 0 ? Math.round((totalPay / totalCost) * 100) / 100 : 0,
    total_visitors: totalVisitors,
    yesterday_total_pay: Math.round(yTotalPay * 100) / 100,
    yesterday_total_cost: Math.round(yTotalCost * 100) / 100,
    shops: shopList, alerts
  });
}));

router.get('/stores/shops/:id/trend', asyncH(async (req, res) => {
  const t = requireTenant();
  const shopIds = await getAccessibleShopIds(req.user);
  if (!shopIds.includes(Number(req.params.id))) return res.status(403).json({ error: '无权访问该店铺' });
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
  const startDate = dateLocalOffset(-days);
  const reports = await repos.adapter.all('SELECT * FROM daily_reports WHERE tenant_id=? AND shop_id=? AND report_date>=? ORDER BY report_date', [t, req.params.id, startDate]);
  const campaigns = await repos.adapter.all('SELECT report_date, SUM(cost) as cost FROM ad_campaigns WHERE tenant_id=? AND shop_id=? AND report_date>=? GROUP BY report_date', [t, req.params.id, startDate]);
  const costMap = {}; campaigns.forEach(c => costMap[c.report_date] = c.cost);
  const trend = reports.map(r => ({
    date: r.report_date, visitors: r.visitors, pay_amount: r.pay_amount,
    cost: costMap[r.report_date] || 0,
    roi: costMap[r.report_date] && r.pay_amount ? Math.round((r.pay_amount / costMap[r.report_date]) * 100) / 100 : null,
    conversion_rate: r.conversion_rate
  }));
  res.json({ trend });
}));

router.get('/stores/shops/:id/campaigns', asyncH(async (req, res) => {
  const t = requireTenant();
  const shopIds = await getAccessibleShopIds(req.user);
  if (!shopIds.includes(Number(req.params.id))) return res.status(403).json({ error: '无权访问该店铺' });
  const days = Math.min(30, Math.max(1, Number(req.query.days) || 1));
  const startDate = dateLocalOffset(-days);
  const params = [t, req.params.id, startDate];
  let platformFilter = '';
  if (req.query.platform) { platformFilter = ' AND platform=?'; params.push(req.query.platform); }
  const campaigns = await repos.adapter.all(`SELECT * FROM ad_campaigns WHERE tenant_id=? AND shop_id=? AND report_date>=?${platformFilter} ORDER BY roi DESC`, params);
  res.json({ campaigns });
}));

// ========== 真实数据查询（商品/商品日报/订单日报/退款日报，多平台筛选）==========
function dataQuery(req, shopIds, t, { table, orderBy }) {
  const params = [t];
  let query = `SELECT d.*, s.shop_name FROM ${table} d JOIN shops s ON d.shop_id=s.id AND s.tenant_id=d.tenant_id WHERE d.tenant_id=? AND d.shop_id IN (${shopIds.length ? shopIds.join(',') : '0'})`;
  if (req.query.shop_id) { query += ' AND d.shop_id=?'; params.push(Number(req.query.shop_id)); }
  if (req.query.platform) { query += ' AND d.platform=?'; params.push(req.query.platform); }
  if (req.query.date) { query += ' AND d.report_date=?'; params.push(req.query.date); }
  if (req.query.date_start) { query += ' AND d.report_date>=?'; params.push(req.query.date_start); }
  if (req.query.date_end) { query += ' AND d.report_date<=?'; params.push(req.query.date_end); }
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  query += ` ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  return { query, params, limit, offset };
}

router.get('/stores/products', asyncH(async (req, res) => {
  const t = requireTenant();
  const shopIds = await getAccessibleShopIds(req.user);
  const params = [t];
  let query = `SELECT p.*, s.shop_name FROM products p JOIN shops s ON p.shop_id=s.id AND s.tenant_id=p.tenant_id WHERE p.tenant_id=? AND p.shop_id IN (${shopIds.length ? shopIds.join(',') : '0'})`;
  if (req.query.shop_id) { query += ' AND p.shop_id=?'; params.push(Number(req.query.shop_id)); }
  if (req.query.platform) { query += ' AND p.platform=?'; params.push(req.query.platform); }
  if (req.query.status) { query += ' AND p.status=?'; params.push(req.query.status); }
  if (req.query.q) { query += ' AND p.title LIKE ?'; params.push('%' + req.query.q + '%'); }
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  query += ' ORDER BY p.id DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  const products = await repos.adapter.all(query, params);
  res.json({ products, limit, offset });
}));

router.get('/stores/product-daily', asyncH(async (req, res) => {
  const t = requireTenant();
  const shopIds = await getAccessibleShopIds(req.user);
  const { query, params, limit, offset } = dataQuery(req, shopIds, t, { table: 'product_daily', orderBy: 'd.report_date DESC, d.pay_amount DESC' });
  res.json({ rows: await repos.adapter.all(query, params), limit, offset });
}));

router.get('/stores/orders', asyncH(async (req, res) => {
  const t = requireTenant();
  const shopIds = await getAccessibleShopIds(req.user);
  const { query, params, limit, offset } = dataQuery(req, shopIds, t, { table: 'orders_daily', orderBy: 'd.report_date DESC' });
  res.json({ rows: await repos.adapter.all(query, params), limit, offset });
}));

router.get('/stores/refunds', asyncH(async (req, res) => {
  const t = requireTenant();
  const shopIds = await getAccessibleShopIds(req.user);
  const { query, params, limit, offset } = dataQuery(req, shopIds, t, { table: 'refunds_daily', orderBy: 'd.report_date DESC' });
  res.json({ rows: await repos.adapter.all(query, params), limit, offset });
}));

router.get('/stores/compare', asyncH(async (req, res) => {
  const t = requireTenant();
  const shopIds = await getAccessibleShopIds(req.user);
  if (!shopIds.length) return res.json({ shops: [] });
  const days = Math.min(30, Math.max(1, Number(req.query.days) || 1));
  const startDate = dateLocalOffset(-days);
  const placeholders = shopIds.map(() => '?').join(',');
  const params = [startDate, startDate, startDate, startDate, t, ...shopIds];
  let platformFilter = '';
  if (req.query.platform) { platformFilter = ' AND s.platform=?'; params.push(req.query.platform); }
  const shops = await repos.adapter.all(`
    SELECT s.id, s.shop_name, s.qianniu_account, s.platform, sg.name as group_name,
      (SELECT SUM(dr.pay_amount) FROM daily_reports dr WHERE dr.tenant_id=s.tenant_id AND dr.shop_id=s.id AND dr.report_date>=?) as total_pay,
      (SELECT SUM(dr.visitors) FROM daily_reports dr WHERE dr.tenant_id=s.tenant_id AND dr.shop_id=s.id AND dr.report_date>=?) as total_visitors,
      (SELECT SUM(ac.cost) FROM ad_campaigns ac WHERE ac.tenant_id=s.tenant_id AND ac.shop_id=s.id AND ac.report_date>=?) as total_cost,
      (SELECT SUM(ac.pay_amount) FROM ad_campaigns ac WHERE ac.tenant_id=s.tenant_id AND ac.shop_id=s.id AND ac.report_date>=?) as ad_pay
    FROM shops s LEFT JOIN shop_groups sg ON s.group_id = sg.id AND sg.tenant_id = s.tenant_id
    WHERE s.tenant_id=? AND s.id IN (${placeholders})${platformFilter}
    ORDER BY total_pay DESC
  `, params);
  const result = shops.map(s => {
    const cost = Number(s.total_cost || 0);
    const pay = Number(s.ad_pay || 0);
    return {
      id: s.id, shop_name: s.shop_name, platform: s.platform, group_name: s.group_name,
      total_pay: Math.round(Number(s.total_pay || 0) * 100) / 100,
      total_visitors: Number(s.total_visitors || 0),
      total_cost: Math.round(cost * 100) / 100,
      roi: cost > 0 ? Math.round((pay / cost) * 100) / 100 : null,
      conversion_rate: s.total_visitors > 0 && s.total_pay > 0 ? Math.round((s.total_pay / s.total_visitors) * 10000) / 100 : null,
      is_burn: cost > BURN_COST_THRESHOLD && (pay / cost || 0) < BURN_ROI_THRESHOLD
    };
  });
  res.json({ shops: result, days });
}));

// ========== 建议审核 ==========
router.get('/stores/suggestions', asyncH(async (req, res) => {
  const t = requireTenant();
  const shopIds = await getAccessibleShopIds(req.user);
  let query = `SELECT * FROM suggestions WHERE tenant_id=? AND shop_id IN (${shopIds.length ? shopIds.join(',') : '0'})`;
  const params = [t];
  if (req.query.date) { query += ' AND suggestion_date=?'; params.push(req.query.date); }
  if (req.query.status) { query += ' AND status=?'; params.push(req.query.status); }
  query += ' ORDER BY suggestion_date DESC, shop_id';
  const suggestions = await repos.adapter.all(query, params);
  const result = [];
  for (const s of suggestions) {
    result.push({ ...s, items: await repos.adapter.all('SELECT * FROM suggestion_items WHERE tenant_id=? AND suggestion_id=?', [t, s.id]) });
  }
  res.json({ suggestions: result });
}));

router.get('/stores/suggestions/:id', asyncH(async (req, res) => {
  const t = requireTenant();
  const suggestion = await repos.adapter.get('SELECT * FROM suggestions WHERE id=? AND tenant_id=?', [req.params.id, t]);
  if (!suggestion) return res.status(404).json({ error: '建议单不存在' });
  const shopIds = await getAccessibleShopIds(req.user);
  if (!shopIds.includes(suggestion.shop_id)) return res.status(403).json({ error: '无权访问该店铺' });
  suggestion.items = await repos.adapter.all('SELECT * FROM suggestion_items WHERE tenant_id=? AND suggestion_id=?', [t, suggestion.id]);
  res.json({ suggestion });
}));

router.post('/stores/suggestions/:id/review', requireRole('boss', 'admin'), asyncH(async (req, res) => {
  const t = requireTenant();
  const { action, comment, item_actions } = req.body;
  const suggestion = await repos.adapter.get('SELECT * FROM suggestions WHERE id=? AND tenant_id=?', [req.params.id, t]);
  if (!suggestion) return res.status(404).json({ error: '建议单不存在' });
  if (suggestion.status !== 'pending') return res.status(400).json({ error: '该建议单已审核' });
  if (!['approve_all', 'reject_all', 'partial'].includes(action)) return res.status(400).json({ error: '无效审核操作' });
  if (action === 'partial' && (!Array.isArray(item_actions) || !item_actions.length || item_actions.some(ia => !Number.isSafeInteger(ia.item_id) || !['approved', 'rejected'].includes(ia.action)))) return res.status(400).json({ error: '无效明细审核操作' });

  const now = new Date().toLocaleString('zh-CN');
  if (action === 'approve_all') {
    await repos.adapter.run('UPDATE suggestions SET status=?, reviewed_by=?, reviewed_at=?, review_comment=? WHERE id=? AND tenant_id=?', ['approved', req.user.id, now, comment || null, req.params.id, t]);
    await repos.adapter.run('UPDATE suggestion_items SET status=? WHERE suggestion_id=? AND tenant_id=? AND status=?', ['approved', req.params.id, t, 'pending']);
  } else if (action === 'reject_all') {
    await repos.adapter.run('UPDATE suggestions SET status=?, reviewed_by=?, reviewed_at=?, review_comment=? WHERE id=? AND tenant_id=?', ['rejected', req.user.id, now, comment || null, req.params.id, t]);
    await repos.adapter.run('UPDATE suggestion_items SET status=? WHERE suggestion_id=? AND tenant_id=? AND status=?', ['rejected', req.params.id, t, 'pending']);
  } else if (action === 'partial' && item_actions) {
    for (const ia of item_actions) {
      await repos.adapter.run('UPDATE suggestion_items SET status=? WHERE id=? AND suggestion_id=? AND tenant_id=?', [ia.action, ia.item_id, req.params.id, t]);
    }
    const statuses = (await repos.adapter.all('SELECT DISTINCT status FROM suggestion_items WHERE suggestion_id=? AND tenant_id=?', [req.params.id, t])).map(r => r.status);
    const overallStatus = statuses.length === 1 ? (statuses[0] === 'approved' ? 'approved' : 'rejected') : 'partial';
    await repos.adapter.run('UPDATE suggestions SET status=?, reviewed_by=?, reviewed_at=?, review_comment=? WHERE id=? AND tenant_id=?', [overallStatus, req.user.id, now, comment || null, req.params.id, t]);
  }
  await logAudit(req.user.id, suggestion.shop_id, 'review', 'suggestion', req.params.id, { action, comment }, req.ip);
  const updated = await repos.adapter.get('SELECT status FROM suggestions WHERE id=? AND tenant_id=?', [req.params.id, t]);
  res.json({ ok: true, status: updated.status });
}));

// 审核通过后 → 生成执行清单（默认人工执行；自动执行时进入待审批）
router.post('/stores/suggestions/:id/execution-list', requireRole('boss', 'admin'), asyncH(async (req, res) => {
  const t = requireTenant();
  const suggestion = await repos.adapter.get('SELECT * FROM suggestions WHERE id=? AND tenant_id=?', [req.params.id, t]);
  if (!suggestion) return res.status(404).json({ error: '建议单不存在' });
  const shopIds = await getAccessibleShopIds(req.user);
  if (!shopIds.includes(suggestion.shop_id)) return res.status(403).json({ error: '无权操作该店铺建议' });
  const items = await repos.adapter.all(
    "SELECT si.*, s.shop_id FROM suggestion_items si JOIN suggestions s ON si.suggestion_id=s.id AND s.tenant_id=si.tenant_id WHERE si.suggestion_id=? AND si.tenant_id=? AND si.status='approved'",
    [suggestion.id, t]
  );
  if (!items.length) return res.status(400).json({ error: '该建议单无已通过审核的明细' });
  const shop = await repos.adapter.get('SELECT * FROM shops WHERE id=? AND tenant_id=?', [suggestion.shop_id, t]);
  const created = [];
  for (const item of items) {
    const c = await executionService.createExecution({ suggestionItem: item, shop, userId: req.user.id });
    created.push(c.id);
  }
  await logAudit(req.user.id, suggestion.shop_id, 'create_execution_list', 'suggestion', suggestion.id, { count: created.length }, req.ip);
  const executions = [];
  for (const id of created) executions.push(await repos.adapter.get('SELECT * FROM executions WHERE id=? AND tenant_id=?', [id, t]));
  res.json({ executions, auto: executionService.autoConfig().enabled });
}));

router.post('/stores/suggestions/generate', asyncH(async (req, res) => {
  if (!FULL_ACCESS_ROLES.includes(req.user.role || 'member')) return res.status(403).json({ error: '仅管理员可触发建议生成' });
  const targetDate = req.query.date || todayLocal();
  const count = await generateSuggestions(targetDate);
  res.json({ message: `已为 ${count} 个店铺生成建议单`, count });
}));

// ========== 执行 ==========
router.post('/stores/executions', requireRole('boss', 'admin'), asyncH(async (req, res) => {
  const t = requireTenant();
  const { suggestion_item_ids } = req.body;
  if (!suggestion_item_ids || !suggestion_item_ids.length) return res.status(400).json({ error: '请选择至少一条建议明细' });

  const shopIds = await getAccessibleShopIds(req.user);
  // 预检：先校验全部明细的归属与状态，避免部分创建后因后续校验失败
  const items = [];
  for (const itemId of suggestion_item_ids) {
    const item = await repos.adapter.get('SELECT si.*, s.shop_id FROM suggestion_items si JOIN suggestions s ON si.suggestion_id=s.id AND s.tenant_id=si.tenant_id WHERE si.id=? AND si.tenant_id=?', [itemId, t]);
    if (!item) continue;
    if (!shopIds.includes(item.shop_id)) return res.status(403).json({ error: `无权操作建议明细 ${itemId}` });
    if (item.status !== 'approved') return res.status(400).json({ error: `建议明细 ${itemId} 未通过审核` });
    items.push(item);
  }

  // B8：按店铺分组并发（店铺间并发、店铺内串行，保证每日调价上限计数正确）
  const byShop = new Map();
  for (const item of items) {
    if (!byShop.has(item.shop_id)) byShop.set(item.shop_id, []);
    byShop.get(item.shop_id).push(item);
  }

  const groupResults = await mapLimit([...byShop.entries()], concurrency('EXEC_CONCURRENCY', 4), async ([, shopItems]) => {
    const out = [];
    for (const item of shopItems) {
      const shop = await repos.adapter.get('SELECT * FROM shops WHERE id=? AND tenant_id=?', [item.shop_id, t]);

      const todayCount = Number((await repos.adapter.get(
        "SELECT COUNT(*) as c FROM executions WHERE tenant_id=? AND shop_id=? AND status IN ('queued','running','success','pending_manual') AND created_at LIKE ?",
        [t, item.shop_id, dayPrefix(todayLocal())]
      )).c);
      if (todayCount >= shop.daily_adjust_limit) {
        out.push({ error: 400, message: `店铺 ${shop.shop_name} 今日已执行 ${todayCount} 次调价，超过上限 ${shop.daily_adjust_limit}` });
        continue;
      }

      if (item.action_type === 'adjust_price' && item.current_value && item.suggested_value) {
        const ratio = Math.abs(item.suggested_value - item.current_value) / item.current_value;
        if (ratio > MAX_ADJUST_RATIO) {
          out.push({ error: 400, message: `计划 ${item.campaign_id} 调价幅度 ${Math.round(ratio * 100)}% 超过上限 ${MAX_ADJUST_RATIO * 100}%` });
          continue;
        }
      }

      const created = await executionService.createExecution({ suggestionItem: item, shop, userId: req.user.id });
      await logAudit(req.user.id, item.shop_id, 'execute', 'execution', created.id, { action_type: item.action_type, campaign_id: item.campaign_id, auto: created.auto }, req.ip);
      const execRow = await repos.adapter.get('SELECT * FROM executions WHERE id=? AND tenant_id=?', [created.id, t]);
      out.push({ execution: { ...execRow, executor: created.auto ? 'rpa' : 'manual' } });
    }
    return out;
  });

  const results = groupResults.flat();
  const firstError = results.find(r => r.error);
  if (firstError) return res.status(firstError.error).json({ error: firstError.message });
  res.json({ executions: results.map(r => r.execution) });
}));

router.get('/stores/executions', asyncH(async (req, res) => {
  const t = requireTenant();
  const shopIds = await getAccessibleShopIds(req.user);
  const params = [t];
  let query = `SELECT e.*, s.shop_name FROM executions e LEFT JOIN shops s ON e.shop_id=s.id AND s.tenant_id=e.tenant_id WHERE e.tenant_id=? AND e.shop_id IN (${shopIds.length ? shopIds.join(',') : '0'})`;
  if (req.query.status) { query += ' AND e.status=?'; params.push(req.query.status); }
  if (req.query.shop_id) {
    const sid = Number(req.query.shop_id);
    if (!shopIds.includes(sid)) return res.status(403).json({ error: '无权访问该店铺执行记录' });
    query += ' AND e.shop_id=?'; params.push(sid);
  }
  if (req.query.is_auto != null && req.query.is_auto !== '') {
    query += ' AND e.is_auto=?';
    params.push(req.query.is_auto === 'true' || req.query.is_auto === '1' ? 1 : 0);
  }
  if (req.query.date_start) { query += ' AND e.created_at >= ?'; params.push(req.query.date_start); }
  if (req.query.date_end) { query += ' AND e.created_at <= ?'; params.push(req.query.date_end + ' 23:59:59'); }
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  query += ' ORDER BY e.created_at DESC, e.id DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  const executions = await repos.adapter.all(query, params);
  res.json({ executions, limit, offset });
}));

// 执行清单导出（人工执行：运营线下操作后按此回填）；支持 CSV / Excel(.xls)
router.get('/stores/executions/export', asyncH(async (req, res) => {
  const t = requireTenant();
  const shopIds = await getAccessibleShopIds(req.user);
  const status = req.query.status || 'pending_manual';
  const format = String(req.query.format || 'csv').toLowerCase();
  const rows = await repos.adapter.all(
    `SELECT e.id, e.shop_id, s.shop_name, e.target_campaign_id, e.action_type, e.expected_value, e.before_value, e.status, e.actual_value, e.created_at
     FROM executions e LEFT JOIN shops s ON e.shop_id=s.id AND s.tenant_id=e.tenant_id
     WHERE e.tenant_id=? AND e.shop_id IN (${shopIds.length ? shopIds.join(',') : '0'}) AND e.status=?
     ORDER BY e.id LIMIT 5000`,
    [t, status]
  );
  const columns = ['execution_id', 'shop_id', 'shop_name', 'campaign_id', 'action_type', 'expected_value', 'before_value', 'status', 'actual_value', 'note'];
  const data = rows.map(r => ({
    execution_id: r.id,
    shop_id: r.shop_id,
    shop_name: r.shop_name,
    campaign_id: r.target_campaign_id,
    action_type: r.action_type,
    expected_value: r.expected_value,
    before_value: r.before_value,
    status: r.status,
    actual_value: r.actual_value,
    note: ''
  }));
  if (format === 'xls' || format === 'excel') {
    res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="executions_${todayLocal()}.xls"`);
    return res.send(toSpreadsheetML('执行清单', columns, data));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="executions_${todayLocal()}.csv"`);
  res.send('\uFEFF' + toCsv(data, columns));
}));

// 批量回填（CSV：execution_id,status,actual_value,note）
router.post('/stores/executions/backfill', requireRole('boss', 'admin'), csvUpload.single('file'), asyncH(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到 CSV 文件' });
  const t = requireTenant();
  const shopIds = await getAccessibleShopIds(req.user);
  const { records } = parseCsv(req.file.buffer.toString('utf8'));
  let success = 0;
  let failed = 0;
  const errors = [];
  for (const r of records) {
    const id = Number(r.execution_id);
    if (!Number.isSafeInteger(id) || id <= 0) { failed++; errors.push({ row: r.__row, message: 'execution_id 非法' }); continue; }
    if (!['success', 'failed'].includes(r.status)) { failed++; errors.push({ row: r.__row, message: 'status 须为 success/failed' }); continue; }
    const exec = await repos.adapter.get('SELECT * FROM executions WHERE id=? AND tenant_id=?', [id, t]);
    if (!exec || !shopIds.includes(exec.shop_id)) { failed++; errors.push({ row: r.__row, message: `执行 ${id} 不存在或无权` }); continue; }
    const actual = (r.actual_value === '' || r.actual_value === undefined) ? null : Number(r.actual_value);
    await repos.adapter.run('UPDATE executions SET status=?, actual_value=?, error_msg=?, finished_at=? WHERE id=? AND tenant_id=?',
      [r.status, actual, r.note || null, nowLocal(), id, t]);
    if (r.status === 'success' && exec.suggestion_item_id) {
      await repos.adapter.run('UPDATE suggestion_items SET status=? WHERE id=? AND tenant_id=?', ['executed', exec.suggestion_item_id, t]);
    }
    success++;
  }
  await logAudit(req.user.id, null, 'execute_backfill_batch', 'execution', null, { success, failed }, req.ip);
  res.json({ success, failed, errors: errors.slice(0, 200) });
}));

// 人工执行回填：写入实际值/结果，成功后标记建议明细已执行
router.post('/stores/executions/:id/backfill', requireRole('boss', 'admin'), asyncH(async (req, res) => {
  const t = requireTenant();
  const { status, actual_value, screenshot_url, error_msg } = req.body || {};
  if (!['success', 'failed'].includes(status)) return res.status(400).json({ error: 'status 须为 success 或 failed' });
  const exec = await repos.adapter.get('SELECT * FROM executions WHERE id=? AND tenant_id=?', [req.params.id, t]);
  if (!exec) return res.status(404).json({ error: '执行记录不存在' });
  const shopIds = await getAccessibleShopIds(req.user);
  if (!shopIds.includes(exec.shop_id)) return res.status(403).json({ error: '无权操作该店铺执行记录' });

  await repos.adapter.run(
    'UPDATE executions SET status=?, actual_value=?, screenshot_url=?, error_msg=?, finished_at=? WHERE id=? AND tenant_id=?',
    [status, actual_value === undefined || actual_value === '' ? null : Number(actual_value), screenshot_url || null, error_msg || null, nowLocal(), exec.id, t]
  );
  if (status === 'success' && exec.suggestion_item_id) {
    await repos.adapter.run('UPDATE suggestion_items SET status=? WHERE id=? AND tenant_id=?', ['executed', exec.suggestion_item_id, t]);
  }
  await logAudit(req.user.id, exec.shop_id, 'execute_backfill', 'execution', exec.id, { status, actual_value }, req.ip);
  res.json({ execution: await repos.adapter.get('SELECT * FROM executions WHERE id=? AND tenant_id=?', [exec.id, t]) });
}));

// 对账：建议值 vs 实际值（actual_value 由人工回填或 RPA 回调写入）
router.get('/stores/executions/:id/reconcile', asyncH(async (req, res) => {
  const t = requireTenant();
  const exec = await repos.adapter.get('SELECT * FROM executions WHERE id=? AND tenant_id=?', [req.params.id, t]);
  if (!exec) return res.status(404).json({ error: '执行记录不存在' });
  const shopIds = await getAccessibleShopIds(req.user);
  if (!shopIds.includes(exec.shop_id)) return res.status(403).json({ error: '无权查看该店铺执行记录' });

  let item = null;
  if (exec.suggestion_item_id) {
    item = await repos.adapter.get('SELECT current_value, suggested_value, action_type FROM suggestion_items WHERE id=? AND tenant_id=?', [exec.suggestion_item_id, t]);
  }
  const expected = item ? item.suggested_value : null;
  const actual = exec.actual_value;
  const diff = (expected != null && actual != null) ? Math.round((actual - expected) * 100) / 100 : null;
  res.json({
    execution: { id: exec.id, shop_id: exec.shop_id, action_type: exec.action_type, target_campaign_id: exec.target_campaign_id, status: exec.status, actual_value: actual, finished_at: exec.finished_at },
    reconcile: {
      action_type: exec.action_type,
      expected_value: expected,
      actual_value: actual,
      diff,
      matched: diff === null ? null : Math.abs(diff) < 1e-9
    }
  });
}));

// ========== 执行闭环（审批 / 回滚 / 对账 / 证据 / 自动执行）==========
// 执行详情（含证据：截图签名、审计留痕）
router.get('/stores/executions/:id', asyncH(async (req, res) => {
  const t = requireTenant();
  const exec = await repos.adapter.get('SELECT e.*, s.shop_name FROM executions e LEFT JOIN shops s ON e.shop_id=s.id AND s.tenant_id=e.tenant_id WHERE e.id=? AND e.tenant_id=?', [req.params.id, t]);
  if (!exec) return res.status(404).json({ error: '执行记录不存在' });
  const shopIds = await getAccessibleShopIds(req.user);
  if (!shopIds.includes(exec.shop_id)) return res.status(403).json({ error: '无权查看该执行记录' });
  let screenshot = null;
  if (exec.screenshot_url) {
    try { screenshot = await signFile(req.user, exec.screenshot_url); } catch (_) { screenshot = exec.screenshot_url; }
  }
  const audit = await repos.adapter.all(
    "SELECT user_id, action, detail_json, ip_address, created_at FROM audit_logs WHERE tenant_id=? AND target_type='execution' AND target_id=? ORDER BY id DESC LIMIT 50",
    [t, String(exec.id)]
  );
  res.json({ execution: exec, evidence: { screenshot_url: screenshot, audit } });
}));

// 自动执行审批：通过 / 驳回
router.post('/stores/executions/:id/approve', requireRole('boss', 'admin'), asyncH(async (req, res) => {
  const exec = await executionService.approve(req.params.id, req.user.id);
  await logAudit(req.user.id, exec.shop_id, 'execute_approve', 'execution', exec.id, null, req.ip);
  res.json({ execution: exec });
}));
router.post('/stores/executions/:id/reject', requireRole('boss', 'admin'), asyncH(async (req, res) => {
  const exec = await executionService.reject(req.params.id, req.user.id);
  await logAudit(req.user.id, exec.shop_id, 'execute_reject', 'execution', exec.id, null, req.ip);
  res.json({ execution: exec });
}));

// 回滚：以执行前值创建反向执行
router.post('/stores/executions/:id/rollback', requireRole('boss', 'admin'), asyncH(async (req, res) => {
  const exec = await executionService.rollback(req.params.id, req.user.id);
  await logAudit(req.user.id, exec.shop_id, 'execute_rollback', 'execution', exec.id, { rollback_of: Number(req.params.id) }, req.ip);
  res.json({ execution: exec });
}));

// 对账报表：期望值 vs 实际值（差异统计 + 明细）
router.get('/stores/reconcile/report', asyncH(async (req, res) => {
  const { dateRange } = require('../validation');
  const shopIds = await getAccessibleShopIds(req.user);
  const { start, end } = dateRange(req.query.date_start, req.query.date_end);
  const report = await reconcileReport({ shopIds, dateStart: start, dateEnd: end + ' 23:59:59', shopId: req.query.shop_id });
  res.json({ date_range: { start, end }, ...report });
}));

// 自动执行：状态与手动触发派发
router.get('/stores/auto-execute/status', requireRole('boss', 'admin'), asyncH(async (req, res) => {
  res.json(await executionService.status());
}));
router.post('/stores/auto-execute/process', requireRole('boss', 'admin'), asyncH(async (req, res) => {
  const result = await executionService.processDue();
  await logAudit(req.user.id, null, 'auto_execute_process', 'execution', null, result, req.ip);
  res.json(result);
}));

// ========== RPA 采集 ==========
router.post('/stores/collect/trigger', asyncH(async (req, res) => {
  if (!FULL_ACCESS_ROLES.includes(req.user.role || 'member')) return res.status(403).json({ error: '仅管理员可触发采集' });
  const t = requireTenant();
  const targetDate = req.query.date || todayLocal();
  const shops = await repos.adapter.all("SELECT * FROM shops WHERE tenant_id=? AND status='active' ORDER BY group_id, id", [t]);
  let count = 0;
  let failed = 0;
  // 返回 job 列表（不再只回「采集完成」）：队列任务标记 queued，同步/真实任务回传 job_id
  const jobs = await mapLimit(shops, concurrency('COLLECT_CONCURRENCY', 5), async (shop, i) => {
    const batchNo = Math.floor(i / 10) + 1;
    try {
      await repos.adapter.run(
        upsertSql(repos.adapter.dialect, 'collection_tasks', ['tenant_id', 'shop_id', 'task_date', 'batch_no', 'status'], ['tenant_id', 'shop_id', 'task_date'], ['batch_no', 'status']),
        [t, shop.id, targetDate, batchNo, 'queued']
      );
      const queued = await enqueue('collect', { tenantId: t, shopId: shop.id, qianniuAccount: shop.qianniu_account, date: targetDate, autoSuggest: true });
      let jobId = null, campaignJobId = null;
      if (!queued) {
        const r = await triggerCollection(shop.id, shop.qianniu_account, targetDate);
        jobId = r.jobId;
        campaignJobId = r.campaignJobId;
      }
      count++;
      return {
        shop_id: shop.id, shop_name: shop.shop_name,
        status: queued ? 'queued' : (MOCK_MODE ? 'success' : 'running'),
        job_id: jobId, campaign_job_id: campaignJobId
      };
    } catch (e) {
      failed++;
      console.error(`[collect] 店铺 ${shop.shop_name} 触发失败:`, e.message);
      return { shop_id: shop.id, shop_name: shop.shop_name, status: 'error', error: e.message };
    }
  });
  // B3：Mock 模式下数据已同步入库，可立即生成建议/预警；
  // 真实模式数据需等 RPA 回调，建议/预警在回调完成后触发。
  let sugCount = 0;
  let alertCount = 0;
  if (!queueEnabled() && MOCK_MODE) {
    sugCount = await generateSuggestions(targetDate);
    try { alertCount = (await runAlertChecks(targetDate)).length; } catch (e) { console.error('预警检测失败:', e.message); }
  }
  const asyncMode = queueEnabled() || !MOCK_MODE;
  res.json({
    message: `采集${MOCK_MODE ? '完成' : '已派发'}，共 ${count} 个店铺${failed ? `，失败 ${failed}` : ''}` +
      `${MOCK_MODE ? `，生成建议 ${sugCount} 份，预警 ${alertCount} 条` : '，建议/预警将在回调完成后生成'}` +
      `${queueEnabled() ? '（已入队异步处理）' : ''}`,
    count, failed, jobs, sug_count: sugCount, alert_count: alertCount, async: asyncMode
  });
}));

router.get('/stores/collect/tasks', asyncH(async (req, res) => {
  const t = requireTenant();
  const targetDate = req.query.date || todayLocal();
  const ids = await getAccessibleShopIds(req.user);
  const tasks = await repos.adapter.all(`
    SELECT ct.*, s.shop_name FROM collection_tasks ct
    JOIN shops s ON ct.shop_id=s.id AND s.tenant_id=ct.tenant_id
    WHERE ct.tenant_id=? AND ct.task_date=? AND ct.shop_id IN (${ids.map(() => '?').join(',') || 'NULL'}) ORDER BY ct.batch_no, ct.shop_id
  `, [t, targetDate, ...ids]);
  res.json({ tasks });
}));

router.post('/stores/collect/retry/:taskId', asyncH(async (req, res) => {
  if (!FULL_ACCESS_ROLES.includes(req.user.role || 'member')) return res.status(403).json({ error: '仅管理员可重试采集' });
  const t = requireTenant();
  const task = await repos.adapter.get('SELECT * FROM collection_tasks WHERE id=? AND tenant_id=?', [req.params.taskId, t]);
  if (!task) return res.status(404).json({ error: '采集任务不存在' });
  if (task.status === 'success') return res.status(400).json({ error: '该任务已成功，无需重试' });
  const shop = await repos.adapter.get('SELECT * FROM shops WHERE id=? AND tenant_id=?', [task.shop_id, t]);
  if (!shop) return res.status(404).json({ error: '店铺不存在' });
  await repos.adapter.run('UPDATE collection_tasks SET status=?, error_msg=NULL WHERE id=? AND tenant_id=?', ['queued', task.id, t]);
  await triggerCollection(task.shop_id, shop.qianniu_account, task.task_date);
  await logAudit(req.user.id, task.shop_id, 'retry_collect', 'collection_task', task.id, { task_date: task.task_date }, req.ip);
  res.json({ message: '重试采集已触发' });
}));

// RPA 回调已迁移至 routes/rpa-callback.js（无 JWT，用 x-callback-token 校验）

// ========== 审计日志 ==========
router.get('/stores/audit-logs', asyncH(async (req, res) => {
  if (!FULL_ACCESS_ROLES.includes(req.user.role || 'member')) return res.status(403).json({ error: '仅管理员可查看审计日志' });
  const t = requireTenant();
  let query = 'SELECT * FROM audit_logs WHERE tenant_id=?';
  const params = [t];
  if (req.query.user_id) { query += ' AND user_id=?'; params.push(Number(req.query.user_id)); }
  if (req.query.shop_id) { query += ' AND shop_id=?'; params.push(Number(req.query.shop_id)); }
  if (req.query.action) { query += ' AND action=?'; params.push(req.query.action); }
  if (req.query.date_start) { query += ' AND created_at >= ?'; params.push(req.query.date_start); }
  if (req.query.date_end) { query += ' AND created_at <= ?'; params.push(req.query.date_end + ' 23:59:59'); }
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  const logs = await repos.adapter.all(query, params);
  res.json({ logs, limit, offset });
}));

module.exports = router;
