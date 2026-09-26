module.exports = {
  id: '0013_agent_workbench',
  up: async db => {
    for (const [name, def] of [['input_options', "TEXT DEFAULT '{}'"], ['favorite', 'INTEGER NOT NULL DEFAULT 0']]) {
      if (db.dialect === 'postgres') await db.exec(`ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS ${name} ${def}`);
      else if (!(await db.all('PRAGMA table_info(agent_runs)')).some(c => c.name === name)) await db.exec(`ALTER TABLE agent_runs ADD COLUMN ${name} ${def}`);
    }
    await db.exec('CREATE INDEX IF NOT EXISTS idx_agent_runs_workbench ON agent_runs(tenant_id,user_id,agent_id,id)');
  }
};
