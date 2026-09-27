// 将工作流结果生成的执行任务与来源运行记录关联，便于审计、去重和回溯。
module.exports = {
  id: '0016_agent_workflow_executions',
  up: async db => {
    const columns = [
      ['workflow_run_id', 'INTEGER'],
      ['workflow_node_key', 'TEXT']
    ];
    for (const [name, def] of columns) {
      if (db.dialect === 'postgres') await db.exec(`ALTER TABLE executions ADD COLUMN IF NOT EXISTS ${name} ${def}`);
      else if (!(await db.all('PRAGMA table_info(executions)')).some(c => c.name === name)) await db.exec(`ALTER TABLE executions ADD COLUMN ${name} ${def}`);
    }
    await db.exec('CREATE INDEX IF NOT EXISTS idx_executions_workflow_run ON executions(tenant_id, workflow_run_id)');
  }
};
