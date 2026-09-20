// ===== 影刀 RPA 客户端 =====
// Mock 模式：本地生成测试数据并直接入库；真实模式：调影刀 OpenAPI 派发任务，
// 结果由 /api/rpa/callback/* 回调写入。
// 修复 B1/B4/B5：真实模式回写 rpa_job_id、按类型选择 app_id、执行回写 job_id。
const crypto = require('crypto');
const { repos } = require('./repositories');
const { upsertSql } = require('./repositories/sql');
const { requireTenant } = require('./repositories/tenant-context');
const { nowLocal } = require('./util');
const collectionState = require('./collection-state');
const { secret } = require('./secrets');

const MOCK_MODE = process.env.RPA_MOCK_MODE !== 'false';
const RPA_API_BASE = process.env.RPA_API_BASE || 'https://openapi.yingdao.com';
const RPA_APP_SECRET = secret('RPA_APP_SECRET');

// 按任务类型选择影刀应用（B4：计划报表使用独立 app_id）
const APP_IDS = {
  daily_report: () => process.env.RPA_APP_ID_DAILY_REPORT,
  campaigns: () => process.env.RPA_APP_ID_AD_CAMPAIGNS,
  execute: () => process.env.RPA_APP_ID_EXECUTE
};

function mockDailyReport(shopId, reportDate) {
  const visitors = Math.floor(Math.random() * 7500) + 500;
  const payedBuyers = Math.floor(Math.random() * 290) + 10;
  const payAmount = Math.round((Math.random() * 29500 + 500) * 100) / 100;
  const payItems = Math.floor(Math.random() * 390) + 10;
  const convRate = Math.round((payedBuyers / visitors) * 10000) / 10000;
  const avgPrice = Math.round((payAmount / payedBuyers) * 100) / 100;
  return { visitors, payed_buyer_count: payedBuyers, pay_amount: payAmount, pay_item_count: payItems, conversion_rate: convRate, avg_unit_price: avgPrice };
}

function mockAdCampaigns(shopId, reportDate) {
  const count = Math.floor(Math.random() * 6) + 3;
  const types = ['standard', 'custom', 'ai'];
  const statuses = ['running', 'running', 'running', 'paused'];
  const names = ['爆款推广', '新品测试', '日常引流', '大促预热', '清仓特卖', '精准引流', '人群定向'];
  const result = [];
  for (let i = 0; i < count; i++) {
    const cost = Math.round((Math.random() * 1950 + 50) * 100) / 100;
    const impressions = Math.floor(Math.random() * 49000) + 1000;
    const clicks = Math.floor(Math.random() * 980) + 20;
    const ctr = Math.round((clicks / impressions) * 10000) / 10000;
    const cpc = Math.round((cost / clicks) * 100) / 100;
    const pay = Math.round(Math.random() * cost * 5 * 100) / 100;
    const roi = Math.round((pay / cost) * 100) / 100;
    result.push({
      campaign_id: `${shopId}_${reportDate.replace(/-/g, '').slice(4)}_${i + 1}`,
      campaign_name: `计划${i + 1}-${names[i % names.length]}`,
      campaign_type: types[i % types.length],
      cost, impressions, clicks, ctr, cpc, pay_amount: pay, roi,
      status: statuses[i % statuses.length]
    });
  }
  return result;
}

async function writeMockCollection(shopId, reportDate, jobId) {
  const t = requireTenant();
  const today = nowLocal();
  const shop = await repos.adapter.get('SELECT platform FROM shops WHERE id=? AND tenant_id=?', [shopId, t]);
  const platform = (shop && shop.platform) || 'taobao';

  const dr = mockDailyReport(shopId, reportDate);
  const drCols = ['tenant_id', 'shop_id', 'report_date', 'visitors', 'payed_buyer_count', 'pay_amount', 'pay_item_count', 'conversion_rate', 'avg_unit_price', 'raw_json', 'collected_at'];
  await repos.adapter.run(
    upsertSql(repos.adapter.dialect, 'daily_reports', drCols, ['shop_id', 'report_date']),
    [t, shopId, reportDate, dr.visitors, dr.payed_buyer_count, dr.pay_amount, dr.pay_item_count, dr.conversion_rate, dr.avg_unit_price, JSON.stringify(dr), today]
  );

  const campaigns = mockAdCampaigns(shopId, reportDate);
  const acCols = ['tenant_id', 'shop_id', 'platform', 'account_id', 'campaign_id', 'campaign_name', 'campaign_type', 'report_date', 'cost', 'impressions', 'clicks', 'ctr', 'cpc', 'pay_amount', 'roi', 'status', 'raw_json', 'collected_at'];
  const acSql = upsertSql(repos.adapter.dialect, 'ad_campaigns', acCols, ['shop_id', 'campaign_id', 'report_date']);
  for (const c of campaigns) {
    await repos.adapter.run(acSql, [t, shopId, platform, null, c.campaign_id, c.campaign_name, c.campaign_type, reportDate, c.cost, c.impressions, c.clicks, c.ctr, c.cpc, c.pay_amount, c.roi, c.status, JSON.stringify(c), today]);
  }

  const taskId = await collectionState.findTaskId(shopId, reportDate);
  if (taskId) await collectionState.markSuccess(taskId, null, jobId);
}

// 采集：Mock 直接入库；真实模式派发日报+计划两个任务并回写 rpa_job_id
async function triggerCollection(shopId, qianniuAccount, reportDate) {
  if (MOCK_MODE) {
    const jobId = `mock_job_${crypto.randomUUID().slice(0, 12)}`;
    await writeMockCollection(shopId, reportDate, jobId);
    return { jobId, campaignJobId: jobId, mock: true };
  }

  const jobId = await _callRpaApi('daily_report', { shop_id: shopId, qianniu_account: qianniuAccount, report_date: reportDate });
  let campaignJobId = null;
  try {
    campaignJobId = await _callRpaApi('campaigns', { shop_id: shopId, qianniu_account: qianniuAccount, report_date: reportDate });
  } catch (e) {
    console.warn(`[rpa] 计划报表采集派发失败（店铺 ${shopId}）:`, e.message);
  }
  // B1：真实模式回写 job_id 与状态，供回调按 job_id 命中
  const taskId = await collectionState.findTaskId(shopId, reportDate);
  if (taskId) await collectionState.markRunning(taskId, jobId);
  return { jobId, campaignJobId, mock: false };
}

async function triggerExecution(executionId, shopId, qianniuAccount, campaignId, action, targetValue) {
  const t = requireTenant();
  if (MOCK_MODE) {
    const jobId = `mock_exec_${crypto.randomUUID().slice(0, 12)}`;
    await repos.adapter.run('UPDATE executions SET status=?, screenshot_url=?, finished_at=?, rpa_job_id=? WHERE id=? AND tenant_id=?',
      ['success', `https://mock.example.com/screenshot/exec_${executionId}.png`, nowLocal(), jobId, executionId, t]);
    const exec = await repos.adapter.get('SELECT suggestion_item_id FROM executions WHERE id=? AND tenant_id=?', [executionId, t]);
    if (exec && exec.suggestion_item_id) {
      await repos.adapter.run('UPDATE suggestion_items SET status=? WHERE id=? AND tenant_id=?', ['executed', exec.suggestion_item_id, t]);
    }
    return jobId;
  }

  const jobId = await _callRpaApi('execute', { shop_id: shopId, qianniu_account: qianniuAccount, campaign_id: campaignId, action, target_value: targetValue, execution_id: String(executionId) });
  // B5：真实模式回写 rpa_job_id，回调可按 job_id 命中
  await repos.adapter.run('UPDATE executions SET status=?, rpa_job_id=?, started_at=? WHERE id=? AND tenant_id=?',
    ['running', jobId, nowLocal(), executionId, t]);
  return jobId;
}

async function _callRpaApi(type, params) {
  const appId = (APP_IDS[type] || APP_IDS.daily_report)();
  if (!appId) throw new Error(`缺少影刀应用配置（${type}），请设置对应的 RPA_APP_ID_*`);
  const resp = await fetch(`${RPA_API_BASE}/oapi/dispatch/v2/job/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RPA_APP_SECRET}` },
    body: JSON.stringify({ app_id: appId, params, uuid: crypto.randomUUID() })
  });
  if (!resp.ok) throw new Error(`RPA API error: ${resp.status}`);
  const data = await resp.json();
  return data.data?.job_id || 'unknown';
}

module.exports = { triggerCollection, triggerExecution, mockDailyReport, mockAdCampaigns, MOCK_MODE };
