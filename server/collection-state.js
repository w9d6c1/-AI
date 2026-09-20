// ===== 采集任务状态机 =====
// 状态：queued → running → success | failed（failed 可经重试回到 queued）
// 幂等：状态更新按 id + tenant_id 定位；数据写入由唯一约束 upsert 保证幂等。
const { repos } = require('./repositories');
const { requireTenant } = require('./repositories/tenant-context');
const { nowLocal } = require('./util');

const STATES = ['queued', 'running', 'success', 'failed'];

// 允许的状态迁移（success 为终态）
const TRANSITIONS = {
  queued: ['running', 'success', 'failed'],
  running: ['success', 'failed', 'queued'],
  failed: ['queued'],
  success: []
};

function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

function maxRetries() {
  const n = Number(process.env.COLLECT_MAX_RETRIES);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 2;
}

async function getTask(taskId) {
  const t = requireTenant();
  return repos.adapter.get('SELECT * FROM collection_tasks WHERE id=? AND tenant_id=?', [taskId, t]);
}

// 置为运行中（真实模式回写 job_id）
async function markRunning(taskId, jobId) {
  const t = requireTenant();
  await repos.adapter.run(
    "UPDATE collection_tasks SET status='running', rpa_job_id=COALESCE(?, rpa_job_id), error_msg=NULL WHERE id=? AND tenant_id=?",
    [jobId || null, taskId, t]
  );
}

// 置为成功（可留原始报文 / 回写 job_id）
async function markSuccess(taskId, rawJson, jobId) {
  const t = requireTenant();
  await repos.adapter.run(
    "UPDATE collection_tasks SET status='success', finished_at=?, error_msg=NULL, raw_json=COALESCE(?, raw_json), rpa_job_id=COALESCE(?, rpa_job_id) WHERE id=? AND tenant_id=?",
    [nowLocal(), rawJson ? JSON.stringify(rawJson) : null, jobId || null, taskId, t]
  );
}

// 按 shop + task_date 定位任务 id（供采集触发方使用）
async function findTaskId(shopId, taskDate) {
  const t = requireTenant();
  const row = await repos.adapter.get('SELECT id FROM collection_tasks WHERE tenant_id=? AND shop_id=? AND task_date=?', [t, shopId, taskDate]);
  return row ? row.id : null;
}

// 失败处理：未达上限回 queued 重试，达上限置 failed。返回 { retried, retryCount, maxRetries }
async function registerFailure(taskId, errorMsg) {
  const t = requireTenant();
  const task = await getTask(taskId);
  const retryCount = task ? (task.retry_count || 0) : 0;
  const limit = maxRetries();
  if (retryCount < limit) {
    await repos.adapter.run(
      "UPDATE collection_tasks SET status='queued', retry_count=?, error_msg=? WHERE id=? AND tenant_id=?",
      [retryCount + 1, errorMsg || '采集失败', taskId, t]
    );
    return { retried: true, retryCount: retryCount + 1, maxRetries: limit };
  }
  await repos.adapter.run(
    "UPDATE collection_tasks SET status='failed', error_msg=?, finished_at=? WHERE id=? AND tenant_id=?",
    [errorMsg || '采集失败', nowLocal(), taskId, t]
  );
  return { retried: false, retryCount, maxRetries: limit };
}

module.exports = { STATES, TRANSITIONS, canTransition, maxRetries, getTask, findTaskId, markRunning, markSuccess, registerFailure };
