// ===== 阶段 5：建议与执行闭环 =====
// executions 增列：期望值/执行前值快照、自动执行审批与倒计时、回滚溯源。
module.exports = {
  id: '0008_stage5_execution_closure',
  up: async (db) => {
    const pg = db.dialect === 'postgres';
    const addCol = async (column, def) => {
      if (pg) {
        await db.exec(`ALTER TABLE executions ADD COLUMN IF NOT EXISTS ${column} ${def}`);
      } else {
        const cols = (await db.all('PRAGMA table_info(executions)')).map(c => c.name);
        if (!cols.includes(column)) await db.exec(`ALTER TABLE executions ADD COLUMN ${column} ${def}`);
      }
    };

    await addCol('expected_value', 'REAL');
    await addCol('before_value', 'REAL');
    await addCol('is_auto', 'INTEGER DEFAULT 0');
    await addCol('approved_by', 'INTEGER');
    await addCol('approved_at', 'TEXT');
    await addCol('not_before', 'TEXT');
    await addCol('rollback_of', 'INTEGER');
    await addCol('reason', 'TEXT');

    await db.exec('CREATE INDEX IF NOT EXISTS idx_executions_status ON executions(tenant_id, status)');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_executions_shop_date ON executions(tenant_id, shop_id, created_at)');
  }
};
