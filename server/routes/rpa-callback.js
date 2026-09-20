// ===== 影刀 RPA 回调路由（无 JWT，用 x-callback-token 校验）=====
// 修复 B1/B3/B5：按 job_id 命中（失败按 shop+日期兜底）、完成后触发建议/预警、回传 actual_value。
// 回调无租户上下文：先以平台身份定位任务，再切换到该租户上下文执行写入。
const express = require('express');
const { repos } = require('../repositories');
const { runAsPlatform, runWithTenant } = require('../repositories/tenant-context');
const { upsertSql } = require('../repositories/sql');
const { triggerCollection } = require('../rpa');
const { generateSuggestions } = require('../suggestion');
const { runAlertChecks } = require('../alert');
const { nowLocal } = require('../util');
const collectionState = require('../collection-state');
const { asyncH } = require('../middleware');
const { secret } = require('../secrets');

const router = express.Router();
const callbackToken = secret('RPA_CALLBACK_TOKEN');
if (!callbackToken) console.warn('[security] 未配置 RPA_CALLBACK_TOKEN，所有 RPA 回调将被拒绝');

function authCallback(req, res, next) {
  if (!callbackToken || req.headers['x-callback-token'] !== callbackToken) {
    return res.status(401).json({ error: '无效的回调密钥' });
  }
  next();
}

// 平台身份定位采集任务：优先 rpa_job_id，其次 shop_id + report_date
async function findCollectTask({ job_id, shop_id, report_date }) {
  return runAsPlatform(async () => {
    let task = null;
    if (job_id) task = await repos.adapter.get('SELECT * FROM collection_tasks WHERE rpa_job_id=?', [job_id]);
    if (!task && shop_id && report_date) {
      task = await repos.adapter.get('SELECT * FROM collection_tasks WHERE shop_id=? AND task_date=?', [shop_id, report_date]);
    }
    return task;
  });
}

async function findExecution({ job_id, execution_id }) {
  return runAsPlatform(async () => {
    let exec = null;
    if (job_id) exec = await repos.adapter.get('SELECT * FROM executions WHERE rpa_job_id=?', [job_id]);
    if (!exec && execution_id) exec = await repos.adapter.get('SELECT * FROM executions WHERE id=?', [Number(execution_id)]);
    return exec;
  });
}

router.post('/rpa/callback/collect', authCallback, asyncH(async (req, res) => {
  const { event, job_id, shop_id, report_date, status, error_msg, data } = req.body || {};
  const task = await findCollectTask({ job_id, shop_id, report_date });
  const tenantId = task ? task.tenant_id : null;
  if (!tenantId) return res.status(404).json({ error: '未找到对应采集任务' });

  return runWithTenant(tenantId, async () => {
    const t = tenantId;
    if (status !== 'success') {
      const r = await collectionState.registerFailure(task.id, error_msg);
      if (r.retried) {
        const shop = await repos.adapter.get('SELECT * FROM shops WHERE id=? AND tenant_id=?', [task.shop_id, t]);
        if (shop) await triggerCollection(task.shop_id, shop.qianniu_account, task.task_date);
        return res.json({ message: `采集失败，自动重试第 ${r.retryCount} 次` });
      }
      return res.json({ message: `采集失败，已达最大重试次数（${r.maxRetries}）` });
    }

    const shopId = shop_id || task.shop_id;
    const date = report_date || task.task_date;
    const shopRow = await repos.adapter.get('SELECT platform FROM shops WHERE id=? AND tenant_id=?', [shopId, t]);
    const shopPlatform = (shopRow && shopRow.platform) || 'taobao';
    const asRows = (v) => (Array.isArray(v) ? v : [v]);

    if (event === 'collect_daily_report' && data) {
      await repos.adapter.run(
        upsertSql(repos.adapter.dialect, 'daily_reports', ['tenant_id', 'shop_id', 'report_date', 'visitors', 'payed_buyer_count', 'pay_amount', 'pay_item_count', 'conversion_rate', 'avg_unit_price', 'raw_json', 'collected_at'], ['shop_id', 'report_date']),
        [t, shopId, date, data.visitors, data.payed_buyer_count, data.pay_amount, data.pay_item_count, data.conversion_rate, data.avg_unit_price, JSON.stringify(data), nowLocal()]
      );
    } else if (event === 'collect_ad_campaigns' && data) {
      const acSql = upsertSql(repos.adapter.dialect, 'ad_campaigns', ['tenant_id', 'shop_id', 'platform', 'account_id', 'campaign_id', 'campaign_name', 'campaign_type', 'report_date', 'cost', 'impressions', 'clicks', 'ctr', 'cpc', 'pay_amount', 'roi', 'status', 'raw_json', 'collected_at'], ['shop_id', 'campaign_id', 'report_date']);
      for (const c of asRows(data)) {
        await repos.adapter.run(acSql, [t, shopId, c.platform || shopPlatform, c.account_id || null, c.campaign_id, c.campaign_name, c.campaign_type, date, c.cost, c.impressions, c.clicks, c.ctr, c.cpc, c.pay_amount, c.roi, c.status, JSON.stringify(c), nowLocal()]);
      }
    } else if (event === 'collect_product_daily' && data) {
      const pdSql = upsertSql(repos.adapter.dialect, 'product_daily', ['tenant_id', 'shop_id', 'platform', 'product_id', 'report_date', 'visitors', 'payed_buyer_count', 'pay_amount', 'pay_item_count', 'refund_amount', 'refund_count', 'conversion_rate', 'avg_unit_price', 'raw_json', 'collected_at'], ['tenant_id', 'shop_id', 'product_id', 'report_date']);
      for (const p of asRows(data)) {
        await repos.adapter.run(pdSql, [t, shopId, p.platform || shopPlatform, p.product_id, date, p.visitors ?? null, p.payed_buyer_count ?? null, p.pay_amount ?? null, p.pay_item_count ?? null, p.refund_amount ?? null, p.refund_count ?? null, p.conversion_rate ?? null, p.avg_unit_price ?? null, JSON.stringify(p), nowLocal()]);
      }
    } else if (event === 'collect_orders_daily' && data) {
      const odSql = upsertSql(repos.adapter.dialect, 'orders_daily', ['tenant_id', 'shop_id', 'platform', 'report_date', 'order_count', 'payed_order_count', 'payed_buyer_count', 'pay_amount', 'refund_order_count', 'refund_amount', 'new_buyer_count', 'old_buyer_count', 'raw_json', 'collected_at'], ['tenant_id', 'shop_id', 'report_date']);
      for (const o of asRows(data)) {
        await repos.adapter.run(odSql, [t, shopId, o.platform || shopPlatform, date, o.order_count ?? null, o.payed_order_count ?? null, o.payed_buyer_count ?? null, o.pay_amount ?? null, o.refund_order_count ?? null, o.refund_amount ?? null, o.new_buyer_count ?? null, o.old_buyer_count ?? null, JSON.stringify(o), nowLocal()]);
      }
    } else if (event === 'collect_refunds_daily' && data) {
      const rdSql = upsertSql(repos.adapter.dialect, 'refunds_daily', ['tenant_id', 'shop_id', 'platform', 'report_date', 'refund_count', 'refund_amount', 'refund_item_count', 'refund_rate', 'reason_top', 'raw_json', 'collected_at'], ['tenant_id', 'shop_id', 'report_date']);
      for (const r of asRows(data)) {
        await repos.adapter.run(rdSql, [t, shopId, r.platform || shopPlatform, date, r.refund_count ?? null, r.refund_amount ?? null, r.refund_item_count ?? null, r.refund_rate ?? null, r.reason_top ?? null, JSON.stringify(r), nowLocal()]);
      }
    }

    // 主任务完成即标记 success 并触发建议/预警（B3：等数据回传后再生成）
    // 计划（ad_campaigns）为附属事件，不单独结束任务
    const isPrimary = event !== 'collect_ad_campaigns';
    if (isPrimary && task.status !== 'success') {
      await collectionState.markSuccess(task.id, { event, data });
      try { await generateSuggestions(date); } catch (e) { console.error('[rpa] 回调生成建议失败:', e.message); }
      try { await runAlertChecks(date); } catch (e) { console.error('[rpa] 回调预警检测失败:', e.message); }
    }
    res.json({ message: '采集数据已入库' });
  });
}));

router.post('/rpa/callback/execute', authCallback, asyncH(async (req, res) => {
  const { job_id, execution_id, status, screenshot_url, error_msg, actual_value } = req.body || {};
  const exec = await findExecution({ job_id, execution_id });
  if (!exec) return res.status(404).json({ error: '执行记录不存在' });
  return runWithTenant(exec.tenant_id, async () => {
    const t = exec.tenant_id;
    await repos.adapter.run(
      'UPDATE executions SET status=?, screenshot_url=?, error_msg=?, actual_value=?, finished_at=? WHERE id=? AND tenant_id=?',
      [status, screenshot_url || null, error_msg || null, actual_value === undefined ? null : actual_value, nowLocal(), exec.id, t]
    );
    if (status === 'success' && exec.suggestion_item_id) {
      await repos.adapter.run('UPDATE suggestion_items SET status=? WHERE id=? AND tenant_id=?', ['executed', exec.suggestion_item_id, t]);
    }
    res.json({ message: '执行结果已更新' });
  });
}));

module.exports = router;
