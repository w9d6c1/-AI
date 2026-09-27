// 每个工作流运行最多生成一个执行批次；批次与其执行明细在同一事务内落库。
const SQLITE = `
CREATE TABLE IF NOT EXISTS agent_workflow_execution_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  workflow_run_id INTEGER NOT NULL,
  created_by INTEGER NOT NULL,
  actions_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(tenant_id, workflow_run_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_workflow_execution_batches_owner ON agent_workflow_execution_batches(tenant_id,created_by,id);
`;

const PG = `
CREATE TABLE IF NOT EXISTS agent_workflow_execution_batches (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  workflow_run_id INTEGER NOT NULL,
  created_by INTEGER NOT NULL,
  actions_json TEXT NOT NULL,
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE(tenant_id, workflow_run_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_workflow_execution_batches_owner ON agent_workflow_execution_batches(tenant_id,created_by,id);
`;

module.exports = {
  id: '0017_agent_workflow_execution_batches',
  up: async db => db.exec(db.dialect === 'postgres' ? PG : SQLITE)
};
