// ===== 执行闭环服务：创建/审批/派发/回滚 =====
// 默认人工执行；自动执行（EXECUTOR_DRIVER=rpa + AUTO_EXECUTE_ENABLED=true）需审批 + 倒计时 +
// 日限额 + 幅度上限 + 熔断；支持回滚。
const { repos } = require('./repositories');
const { requireTenant } = require('./repositories/tenant-context');
const { dayPrefix } = require('./repositories/sql');
const { nowLocal, todayLocal } = require('./util');
const executors = require('./integrations/executors');

const MAX_ADJUST_RATIO = Number(process.env.MAX_ADJUST_RATIO || 0.3);
// 已派发/已占用的执行（不含 queued/pending_approval，避免派发时把自身计入限额）
const DISPATCHED_STATUSES = ['running', 'success', 'pending_manual'];

function clampInt(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function autoConfig() {
  return {
    enabled: String(process.env.EXECUTOR_DRIVER || 'manual').toLowerCase() === 'rpa' && process.env.AUTO_EXECUTE_ENABLED === 'true',
    countdownSec: clampInt(process.env.AUTO_EXECUTE_COUNTDOWN_SEC, 60, 0, 3600),
    failureThreshold: clampInt(process.env.AUTO_EXECUTE_FAILURE_THRESHOLD, 5, 1, 100),
    cooldownMin: clampInt(process.env.AUTO_EXECUTE_COOLDOWN_MIN, 30, 1, 1440)
  };
}

// 熔断：冷却窗口内自动执行失败数达阈值
async function circuitOpen() {
  const t = requireTenant();
  const cfg = autoConfig();
  const since = nowLocal(new Date(Date.now() - cfg.cooldownMin * 60000));
  const row = await repos.adapter.get(
    "SELECT COUNT(*) c FROM executions WHERE tenant_id=? AND is_auto=1 AND status='failed' AND finished_at >= ?",
    [t, since]
  );
  return Number((row && row.c) || 0) >= cfg.failureThreshold;
}

async function dailyCount(shopId) {
  const t = requireTenant();
  const placeholders = DISPATCHED_STATUSES.map(() => '?').join(',');
  const row = await repos.adapter.get(
    `SELECT COUNT(*) c FROM executions WHERE tenant_id=? AND shop_id=? AND status IN (${placeholders}) AND created_at LIKE ?`,
    [t, shopId, ...DISPATCHED_STATUSES, dayPrefix(todayLocal())]
  );
  return Number((row && row.c) || 0);
}

// 创建执行：人工→pending_manual；自动→pending_approval（倒计时 not_before）
async function createExecution({ suggestionItem, shop, userId, workflowRunId = null, workflowNodeKey = null }) {
  const t = requireTenant();
  const cfg = autoConfig();
  const expected = suggestionItem.suggested_value ?? null;
  const before = suggestionItem.current_value ?? null;
  const params = {
    campaign_id: suggestionItem.campaign_id,
    action: suggestionItem.action_type,
    target_value: expected,
    qianniu_account: shop.qianniu_account
  };
  const now = nowLocal();

  if (cfg.enabled) {
    const notBefore = nowLocal(new Date(Date.now() + cfg.countdownSec * 1000));
    const info = await repos.adapter.run(
      'INSERT INTO executions (tenant_id, suggestion_item_id, shop_id, action_type, target_campaign_id, params_json, status, expected_value, before_value, is_auto, not_before, reason, workflow_run_id, workflow_node_key, started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [t, suggestionItem.id || null, suggestionItem.shop_id, suggestionItem.action_type, suggestionItem.campaign_id, JSON.stringify(params), 'pending_approval', expected, before, 1, notBefore, suggestionItem.reason || null, workflowRunId, workflowNodeKey, now]
    );
    return { id: info.lastInsertRowid, status: 'pending_approval', auto: true, not_before: notBefore };
  }

  const info = await repos.adapter.run(
    'INSERT INTO executions (tenant_id, suggestion_item_id, shop_id, action_type, target_campaign_id, params_json, status, expected_value, before_value, is_auto, reason, workflow_run_id, workflow_node_key, started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [t, suggestionItem.id || null, suggestionItem.shop_id, suggestionItem.action_type, suggestionItem.campaign_id, JSON.stringify(params), 'queued', expected, before, 0, suggestionItem.reason || null, workflowRunId, workflowNodeKey, now]
  );
  const execId = info.lastInsertRowid;
  await executors.get('manual').execute({
    executionId: execId, shopId: suggestionItem.shop_id, qianniuAccount: shop.qianniu_account,
    campaignId: suggestionItem.campaign_id, action: suggestionItem.action_type, targetValue: expected || 0
  });
  return { id: execId, status: 'pending_manual', auto: false };
}

async function getExecution(id) {
  const t = requireTenant();
  return repos.adapter.get('SELECT * FROM executions WHERE id=? AND tenant_id=?', [id, t]);
}

// 审批通过：pending_approval → queued（等 not_before 到期由 processDue 派发）
async function approve(id, userId) {
  const t = requireTenant();
  const exec = await getExecution(id);
  if (!exec) { const e = new Error('执行记录不存在'); e.status = 404; throw e; }
  if (exec.status !== 'pending_approval') { const e = new Error('该执行不在待审批状态'); e.status = 400; throw e; }
  await repos.adapter.run("UPDATE executions SET status='queued', approved_by=?, approved_at=? WHERE id=? AND tenant_id=?", [userId || null, nowLocal(), id, t]);
  return getExecution(id);
}

async function reject(id, userId) {
  const t = requireTenant();
  const exec = await getExecution(id);
  if (!exec) { const e = new Error('执行记录不存在'); e.status = 404; throw e; }
  if (exec.status !== 'pending_approval') { const e = new Error('该执行不在待审批状态'); e.status = 400; throw e; }
  await repos.adapter.run("UPDATE executions SET status='rejected', approved_by=?, approved_at=?, finished_at=? WHERE id=? AND tenant_id=?", [userId || null, nowLocal(), nowLocal(), id, t]);
  return getExecution(id);
}

// 回滚：以执行前值创建一笔反向执行（人工执行，需线下确认）
async function rollback(id, userId) {
  const t = requireTenant();
  const exec = await getExecution(id);
  if (!exec) { const e = new Error('执行记录不存在'); e.status = 404; throw e; }
  if (!['success', 'failed'].includes(exec.status)) { const e = new Error('仅已结束的执行可回滚'); e.status = 400; throw e; }
  if (exec.before_value == null) { const e = new Error('该执行无执行前值，无法回滚'); e.status = 400; throw e; }
  const shop = await repos.adapter.get('SELECT * FROM shops WHERE id=? AND tenant_id=?', [exec.shop_id, t]);
  const params = { campaign_id: exec.target_campaign_id, action: exec.action_type, target_value: exec.before_value, qianniu_account: shop ? shop.qianniu_account : null, rollback_of: exec.id };
  const info = await repos.adapter.run(
    'INSERT INTO executions (tenant_id, shop_id, action_type, target_campaign_id, params_json, status, expected_value, before_value, is_auto, rollback_of, reason, started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [t, exec.shop_id, exec.action_type, exec.target_campaign_id, JSON.stringify(params), 'queued', exec.before_value, exec.actual_value ?? exec.expected_value, 0, exec.id, `回滚执行 #${exec.id}（操作人 ${userId || '-'}）`, nowLocal()]
  );
  const rollbackId = info.lastInsertRowid;
  await executors.get('manual').execute({
    executionId: rollbackId, shopId: exec.shop_id, qianniuAccount: shop ? shop.qianniu_account : null,
    campaignId: exec.target_campaign_id, action: exec.action_type, targetValue: exec.before_value
  });
  return getExecution(rollbackId);
}

// 派发到期自动执行（需租户上下文）。返回统计。
async function processDue({ limit = 50 } = {}) {
  const cfg = autoConfig();
  const result = { dispatched: 0, skipped: 0, blocked: false };
  if (!cfg.enabled) return result;
  const t = requireTenant();
  if (await circuitOpen()) { result.blocked = true; return result; }

  const now = nowLocal();
  const due = await repos.adapter.all(
    "SELECT * FROM executions WHERE tenant_id=? AND is_auto=1 AND status='queued' AND (not_before IS NULL OR not_before <= ?) ORDER BY id LIMIT ?",
    [t, now, limit]
  );

  for (const exec of due) {
    if (await circuitOpen()) { result.blocked = true; break; }
    const shop = await repos.adapter.get('SELECT * FROM shops WHERE id=? AND tenant_id=?', [exec.shop_id, t]);
    if (!shop) {
      await repos.adapter.run("UPDATE executions SET status='failed', error_msg=?, finished_at=? WHERE id=? AND tenant_id=?", ['店铺不存在', nowLocal(), exec.id, t]);
      result.skipped++; continue;
    }
    const count = await dailyCount(exec.shop_id);
    if (count >= shop.daily_adjust_limit) {
      await repos.adapter.run("UPDATE executions SET status='skipped', error_msg=?, finished_at=? WHERE id=? AND tenant_id=?", [`超过每日调价上限 ${shop.daily_adjust_limit}`, nowLocal(), exec.id, t]);
      result.skipped++; continue;
    }
    if (exec.action_type === 'adjust_price' && exec.before_value && exec.expected_value) {
      const ratio = Math.abs(exec.expected_value - exec.before_value) / exec.before_value;
      if (ratio > MAX_ADJUST_RATIO) {
        await repos.adapter.run("UPDATE executions SET status='skipped', error_msg=?, finished_at=? WHERE id=? AND tenant_id=?", [`调价幅度 ${Math.round(ratio * 100)}% 超过上限 ${MAX_ADJUST_RATIO * 100}%`, nowLocal(), exec.id, t]);
        result.skipped++; continue;
      }
    }
    try {
      await executors.get('rpa').execute({
        executionId: exec.id, shopId: exec.shop_id, qianniuAccount: shop.qianniu_account,
        campaignId: exec.target_campaign_id, action: exec.action_type, targetValue: exec.expected_value || 0
      });
      result.dispatched++;
    } catch (e) {
      await repos.adapter.run("UPDATE executions SET status='failed', error_msg=?, finished_at=? WHERE id=? AND tenant_id=?", [e.message, nowLocal(), exec.id, t]);
      result.skipped++;
    }
  }
  return result;
}

async function status() {
  const t = requireTenant();
  const cfg = autoConfig();
  const rows = await repos.adapter.all(
    "SELECT status, COUNT(*) c FROM executions WHERE tenant_id=? AND is_auto=1 GROUP BY status",
    [t]
  );
  const counts = {};
  rows.forEach(r => { counts[r.status] = Number(r.c); });
  return {
    auto_execute_enabled: cfg.enabled,
    countdown_sec: cfg.countdownSec,
    failure_threshold: cfg.failureThreshold,
    cooldown_min: cfg.cooldownMin,
    circuit_open: cfg.enabled ? await circuitOpen() : false,
    pending_approval: counts.pending_approval || 0,
    queued: counts.queued || 0,
    counts
  };
}

module.exports = {
  MAX_ADJUST_RATIO, autoConfig, circuitOpen, createExecution, getExecution,
  approve, reject, rollback, processDue, status
};
