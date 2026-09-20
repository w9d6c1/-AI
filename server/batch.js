// ===== 批量操作服务 =====
// 支持：批量改价、批量关停、批量加预算、批量启用
// 流程：创建 → 预览（生成batch_items）→ 确认执行 → 执行器（人工/RPA）
const { repos } = require('./repositories');
const { dayPrefix } = require('./repositories/sql');
const { todayLocal, nowLocal } = require('./util');
const { requireTenant } = require('./repositories/tenant-context');
const executors = require('./integrations/executors');

const MAX_ADJUST_RATIO = 0.3;

async function generatePreview(batchOp) {
  const t = requireTenant();
  const filters = batchOp.filters_json ? JSON.parse(batchOp.filters_json) : {};
  const params = batchOp.params_json ? JSON.parse(batchOp.params_json) : {};
  const today = todayLocal();

  let shops = [];
  if (batchOp.target_type === 'all') {
    shops = await repos.adapter.all("SELECT * FROM shops WHERE status='active' AND tenant_id=?", [t]);
  } else if (batchOp.target_type === 'group') {
    const ids = JSON.parse(batchOp.target_ids || '[]');
    if (ids.length) shops = await repos.adapter.all(`SELECT * FROM shops WHERE status='active' AND group_id IN (${ids.map(() => '?').join(',')}) AND tenant_id=?`, [...ids, t]);
  } else if (batchOp.target_type === 'specific') {
    const ids = JSON.parse(batchOp.target_ids || '[]');
    if (ids.length) shops = await repos.adapter.all(`SELECT * FROM shops WHERE status='active' AND id IN (${ids.map(() => '?').join(',')}) AND tenant_id=?`, [...ids, t]);
  }

  const items = [];
  for (const shop of shops) {
    let query = 'SELECT * FROM ad_campaigns WHERE shop_id=? AND report_date=? AND tenant_id=?';
    const args = [shop.id, today, t];
    if (filters.status) { query += ' AND status=?'; args.push(filters.status); }
    if (filters.min_cost) { query += ' AND cost>=?'; args.push(Number(filters.min_cost)); }
    if (filters.max_roi) { query += ' AND roi<=?'; args.push(Number(filters.max_roi)); }
    if (filters.min_roi) { query += ' AND roi>=?'; args.push(Number(filters.min_roi)); }
    if (filters.campaign_type) { query += ' AND campaign_type=?'; args.push(filters.campaign_type); }

    const campaigns = await repos.adapter.all(query, args);

    for (const c of campaigns) {
      let targetValue = null;
      if (batchOp.action_type === 'adjust_price') {
        targetValue = params.adjust_percent != null
          ? Math.round(c.cpc * (1 + params.adjust_percent / 100) * 100) / 100
          : params.target_cpc || null;
      } else if (batchOp.action_type === 'pause') {
        targetValue = 0;
      } else if (batchOp.action_type === 'add_budget') {
        targetValue = params.add_percent != null
          ? Math.round(c.cost * (1 + params.add_percent / 100) * 100) / 100
          : params.add_amount || null;
      } else if (batchOp.action_type === 'resume') {
        targetValue = 1;
      }
      items.push({
        shop_id: shop.id,
        shop_name: shop.shop_name,
        campaign_id: c.campaign_id,
        campaign_name: c.campaign_name,
        action_type: batchOp.action_type,
        current_value: batchOp.action_type === 'adjust_price' ? c.cpc : (batchOp.action_type === 'add_budget' ? c.cost : null),
        target_value: targetValue
      });
    }
  }

  return items;
}

async function executeBatch(batchId) {
  const t = requireTenant();
  const batch = await repos.adapter.get('SELECT * FROM batch_operations WHERE id=? AND tenant_id=?', [batchId, t]);
  if (!batch) throw new Error('批量操作不存在');
  if (batch.status !== 'confirmed') throw new Error('批量操作需先确认才能执行');

  const items = await repos.adapter.all('SELECT * FROM batch_items WHERE batch_id=? AND status=? AND tenant_id=?', [batchId, 'pending', t]);
  await repos.adapter.run('UPDATE batch_operations SET status=?, executed_at=? WHERE id=? AND tenant_id=?', ['running', nowLocal(), batchId, t]);

  let successCount = 0, failedCount = 0;
  for (const item of items) {
    try {
      const shop = await repos.adapter.get('SELECT * FROM shops WHERE id=? AND tenant_id=?', [item.shop_id, t]);

      if (item.action_type === 'adjust_price' && item.current_value && item.target_value) {
        const ratio = Math.abs(item.target_value - item.current_value) / item.current_value;
        if (ratio > MAX_ADJUST_RATIO) {
          await repos.adapter.run('UPDATE batch_items SET status=?, error_msg=?, finished_at=? WHERE id=? AND tenant_id=?',
            ['skipped', `调价幅度 ${Math.round(ratio * 100)}% 超过上限 ${MAX_ADJUST_RATIO * 100}%`, nowLocal(), item.id, t]);
          continue;
        }
      }

      const todayCount = Number((await repos.adapter.get(
        "SELECT COUNT(*) as c FROM executions WHERE shop_id=? AND status IN ('queued','running','success','pending_manual') AND created_at LIKE ? AND tenant_id=?",
        [item.shop_id, dayPrefix(todayLocal()), t]
      )).c);
      if (todayCount >= shop.daily_adjust_limit) {
        await repos.adapter.run('UPDATE batch_items SET status=?, error_msg=?, finished_at=? WHERE id=? AND tenant_id=?',
          ['skipped', `超过每日调价上限 ${shop.daily_adjust_limit}`, nowLocal(), item.id, t]);
        continue;
      }

      const execInfo = await repos.adapter.run(
        'INSERT INTO executions (tenant_id, shop_id, action_type, target_campaign_id, params_json, status, started_at) VALUES (?,?,?,?,?,?,?)',
        [t, item.shop_id, item.action_type, item.campaign_id, JSON.stringify({ campaign_id: item.campaign_id, action: item.action_type, target_value: item.target_value, qianniu_account: shop.qianniu_account }), 'queued', nowLocal()]
      );
      const execId = execInfo.lastInsertRowid;

      const result = await executors.active().execute({
        executionId: execId, shopId: item.shop_id, qianniuAccount: shop.qianniu_account,
        campaignId: item.campaign_id, action: item.action_type, targetValue: item.target_value || 0
      });

      // B6：rpa_job_id 记真实 job（人工执行无 job 记 null），execution_id 关联执行记录
      await repos.adapter.run('UPDATE batch_items SET status=?, rpa_job_id=?, execution_id=?, executed_at=?, finished_at=? WHERE id=? AND tenant_id=?',
        ['success', result.jobId || null, execId, nowLocal(), nowLocal(), item.id, t]);
      successCount++;
    } catch (e) {
      await repos.adapter.run('UPDATE batch_items SET status=?, error_msg=?, finished_at=? WHERE id=? AND tenant_id=?',
        ['failed', e.message, nowLocal(), item.id, t]);
      failedCount++;
    }
  }

  const status = failedCount === 0 ? 'completed' : (successCount === 0 ? 'failed' : 'partial');
  await repos.adapter.run('UPDATE batch_operations SET status=?, success_count=?, failed_count=?, finished_at=? WHERE id=? AND tenant_id=?',
    [status, successCount, failedCount, nowLocal(), batchId, t]);

  return { batchId, status, successCount, failedCount, totalItems: items.length };
}

module.exports = { generatePreview, executeBatch, MAX_ADJUST_RATIO };
