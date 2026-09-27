// ===== Schema 迁移运行器 =====
// 迁移为「按序、幂等、记录在 schema_migrations」。
// 每个迁移：{ id: '0001_baseline', up: async (db) => {} }，db 为仓储适配器。
const migrations = [
  require('./0001_baseline'),
  require('./0002_collection_tasks_constraints'),
  require('./0003_tenants'),
  require('./0004_ai_usage'),
  require('./0005_stage2_integrations'),
  require('./0006_stage3_data_model'),
  require('./0007_stage4_ai'),
  require('./0008_stage5_execution_closure'),
  require('./0009_stage7_security'),
  require('./0010_stage9_billing'),
  require('./0011_stage9_quota_tokens'),
  require('./0012_stage9_invoicing'),
  require('./0013_agent_workbench'),
  require('./0014_agent_workflows'),
  require('./0015_agent_workflow_reviews'),
  require('./0016_agent_workflow_executions'),
  require('./0017_agent_workflow_execution_batches')
];

async function runMigrations(db) {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  const applied = new Set((await db.all('SELECT id FROM schema_migrations')).map(r => r.id));
  const executed = [];
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    await db.tx(async (tx) => { await m.up(tx); });
    await db.run('INSERT INTO schema_migrations (id) VALUES (?)', [m.id]);
    executed.push(m.id);
  }
  return executed;
}

module.exports = { runMigrations, migrations };
