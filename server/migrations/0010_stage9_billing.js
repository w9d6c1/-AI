// ===== 阶段 9：多租户运营——租户计费与配额字段 =====
// tenants +billing_cycle/price_per_month/max_cost_per_month/trial_ends_at/contact_name/contact_email
// 新库由 db.js / pg-schema.sql 直接建列；既有库经本迁移 ALTER 增列（幂等）。
module.exports = {
  id: '0010_stage9_billing',
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

    await addCol('tenants', 'billing_cycle', "TEXT DEFAULT 'monthly'");
    await addCol('tenants', 'price_per_month', pg ? 'DOUBLE PRECISION DEFAULT 0' : 'REAL DEFAULT 0');
    await addCol('tenants', 'max_cost_per_month', pg ? 'DOUBLE PRECISION DEFAULT 0' : 'REAL DEFAULT 0');
    await addCol('tenants', 'trial_ends_at', 'TEXT');
    await addCol('tenants', 'contact_name', 'TEXT');
    await addCol('tenants', 'contact_email', 'TEXT');
  }
};
