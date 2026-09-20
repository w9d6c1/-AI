// ===== 阶段 7：安全与合规的数据结构 =====
// users 增安全字段：TOTP 两步验证、登录锁定、密码策略/历史。
// audit_logs 增 user_agent。
const USER_COLUMNS = [
  ['totp_secret', 'TEXT'],
  ['totp_enabled', 'INTEGER DEFAULT 0'],
  ['totp_recovery', 'TEXT'],
  ['failed_login_count', 'INTEGER DEFAULT 0'],
  ['locked_until', 'TEXT'],
  ['password_changed_at', 'TEXT'],
  ['password_history', 'TEXT'],
  ['must_change_password', 'INTEGER DEFAULT 0']
];

module.exports = {
  id: '0009_stage7_security',
  up: async (db) => {
    const pg = db.dialect === 'postgres';
    const addCol = async (table, column, def) => {
      if (pg) {
        await db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${def}`);
      } else {
        const cols = (await db.all(`PRAGMA table_info(${table})`)).map(c => c.name);
        if (!cols.includes(column)) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
      }
    };
    for (const [col, def] of USER_COLUMNS) await addCol('users', col, def);
    await addCol('audit_logs', 'user_agent', 'TEXT');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_users_locked ON users(tenant_id, locked_until)');
  }
};
