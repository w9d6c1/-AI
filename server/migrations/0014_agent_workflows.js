// 智能体工作流：保存节点定义、运行实例和每个节点的结果快照。
const SQLITE = `
CREATE TABLE IF NOT EXISTS agent_workflows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  definition_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_agent_workflows_owner ON agent_workflows(tenant_id,user_id,id);
CREATE TABLE IF NOT EXISTS agent_workflow_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  workflow_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  current_node TEXT,
  input_json TEXT DEFAULT '{}',
  output_json TEXT DEFAULT '{}',
  error_message TEXT,
  started_at TEXT DEFAULT (datetime('now','localtime')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_workflow_runs_owner ON agent_workflow_runs(tenant_id,user_id,id);
CREATE TABLE IF NOT EXISTS agent_workflow_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  run_id INTEGER NOT NULL,
  node_key TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  input_json TEXT DEFAULT '{}',
  result_json TEXT DEFAULT '{}',
  source_run_id INTEGER,
  node_type TEXT NOT NULL DEFAULT 'agent',
  review_status TEXT,
  reviewed_by INTEGER,
  reviewed_at TEXT,
  review_note TEXT,
  error_message TEXT,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_workflow_nodes_run ON agent_workflow_nodes(tenant_id,run_id,position);
`;

const PG = `
CREATE TABLE IF NOT EXISTS agent_workflows (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  definition_json TEXT NOT NULL,
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_agent_workflows_owner ON agent_workflows(tenant_id,user_id,id);
CREATE TABLE IF NOT EXISTS agent_workflow_runs (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  workflow_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  current_node TEXT,
  input_json TEXT DEFAULT '{}',
  output_json TEXT DEFAULT '{}',
  error_message TEXT,
  started_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_workflow_runs_owner ON agent_workflow_runs(tenant_id,user_id,id);
CREATE TABLE IF NOT EXISTS agent_workflow_nodes (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  run_id INTEGER NOT NULL,
  node_key TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  input_json TEXT DEFAULT '{}',
  result_json TEXT DEFAULT '{}',
  source_run_id INTEGER,
  node_type TEXT NOT NULL DEFAULT 'agent',
  review_status TEXT,
  reviewed_by INTEGER,
  reviewed_at TEXT,
  review_note TEXT,
  error_message TEXT,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_workflow_nodes_run ON agent_workflow_nodes(tenant_id,run_id,position);
`;

module.exports = {
  id: '0014_agent_workflows',
  up: async db => db.exec(db.dialect === 'postgres' ? PG : SQLITE)
};
