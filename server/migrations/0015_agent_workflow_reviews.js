// 工作流人工审核节点字段。
module.exports = {
  id: '0015_agent_workflow_reviews',
  up: async db => {
    const columns = [
      ['node_type', "TEXT NOT NULL DEFAULT 'agent'"],
      ['review_status', 'TEXT'],
      ['reviewed_by', 'INTEGER'],
      ['reviewed_at', 'TEXT'],
      ['review_note', 'TEXT']
    ];
    for (const [name, def] of columns) {
      if (db.dialect === 'postgres') await db.exec(`ALTER TABLE agent_workflow_nodes ADD COLUMN IF NOT EXISTS ${name} ${def}`);
      else if (!(await db.all('PRAGMA table_info(agent_workflow_nodes)')).some(c => c.name === name)) await db.exec(`ALTER TABLE agent_workflow_nodes ADD COLUMN ${name} ${def}`);
    }
  }
};
