// ===== 数据保留/删除策略 =====
// 按租户清理超过保留期的审计/通知/任务日志/智能体运行/预警。
const { repos } = require('./repositories');
const { runWithTenant, runAsPlatform } = require('./repositories/tenant-context');
const { nowLocal } = require('./util');

const POLICIES = [
  { table: 'audit_logs', env: 'RETENTION_AUDIT_DAYS', days: 180, column: 'created_at' },
  { table: 'notifications', env: 'RETENTION_NOTIFICATION_DAYS', days: 90, column: 'sent_at' },
  { table: 'task_logs', env: 'RETENTION_TASKLOG_DAYS', days: 90, column: 'created_at' },
  { table: 'agent_runs', env: 'RETENTION_AGENTRUN_DAYS', days: 180, column: 'created_at' },
  { table: 'alerts', env: 'RETENTION_ALERT_DAYS', days: 180, column: 'triggered_at' }
];

function policyDays(p) {
  const n = Number(process.env[p.env]);
  return Number.isFinite(n) && n >= 0 ? n : p.days;
}

function cutoff(days) {
  return nowLocal(new Date(Date.now() - days * 86400000));
}

// 清理单个租户；返回各表删除行数
async function purgeTenant(tenantId) {
  const result = {};
  await runWithTenant(tenantId, async () => {
    for (const p of POLICIES) {
      const days = policyDays(p);
      if (days <= 0) { result[p.table] = 0; continue; }
      const info = await repos.adapter.run(
        `DELETE FROM ${p.table} WHERE tenant_id=? AND ${p.column} IS NOT NULL AND ${p.column} < ?`,
        [tenantId, cutoff(days)]
      );
      result[p.table] = Number(info.changes || 0);
    }
  });
  return result;
}

async function runRetention() {
  const tenants = await runAsPlatform(() => repos.adapter.all('SELECT id FROM tenants'));
  const summary = {};
  for (const t of tenants) summary[t.id] = await purgeTenant(t.id);
  return summary;
}

module.exports = { POLICIES, policyDays, purgeTenant, runRetention };
