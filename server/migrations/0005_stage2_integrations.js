// ===== 阶段 2：集成适配层数据结构 =====
// - import_batches：CSV 等导入批次与导入报告
// - executions.actual_value：执行后实际值（对账用）
// - batch_items.execution_id：批量明细关联的 execution（rpa_job_id 回归真实 job）
// - collection_tasks 唯一约束升级为 (tenant_id, shop_id, task_date)
const SQLITE = `
CREATE TABLE IF NOT EXISTS import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'csv',
  file_name TEXT,
  status TEXT DEFAULT 'pending',
  total_rows INTEGER DEFAULT 0,
  success_rows INTEGER DEFAULT 0,
  failed_rows INTEGER DEFAULT 0,
  errors_json TEXT,
  summary_json TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  finished_at TEXT
);`;

const PG = `
CREATE TABLE IF NOT EXISTS import_batches (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'csv',
  file_name TEXT,
  status TEXT DEFAULT 'pending',
  total_rows INTEGER DEFAULT 0,
  success_rows INTEGER DEFAULT 0,
  failed_rows INTEGER DEFAULT 0,
  errors_json TEXT,
  summary_json TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  finished_at TEXT
);`;

module.exports = {
  id: '0005_stage2_integrations',
  up: async (db) => {
    const pg = db.dialect === 'postgres';
    await db.exec(pg ? PG : SQLITE);
    await db.exec('CREATE INDEX IF NOT EXISTS idx_import_batches_tenant ON import_batches(tenant_id)');

    if (pg) {
      await db.exec('ALTER TABLE executions ADD COLUMN IF NOT EXISTS actual_value DOUBLE PRECISION');
      await db.exec('ALTER TABLE batch_items ADD COLUMN IF NOT EXISTS execution_id INTEGER');
      await db.exec('ALTER TABLE collection_tasks DROP CONSTRAINT IF EXISTS collection_tasks_shop_date_key');
      await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_collection_tasks_tenant_shop_date ON collection_tasks(tenant_id, shop_id, task_date)');
    } else {
      const execCols = (await db.all('PRAGMA table_info(executions)')).map(c => c.name);
      if (!execCols.includes('actual_value')) await db.exec('ALTER TABLE executions ADD COLUMN actual_value REAL');
      const itemCols = (await db.all('PRAGMA table_info(batch_items)')).map(c => c.name);
      if (!itemCols.includes('execution_id')) await db.exec('ALTER TABLE batch_items ADD COLUMN execution_id INTEGER');
      await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_collection_tasks_tenant_shop_date ON collection_tasks(tenant_id, shop_id, task_date)');
    }
  }
};
