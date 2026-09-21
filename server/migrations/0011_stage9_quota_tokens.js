// ===== 阶段 9：多租户运营——按 token 配额 =====
// tenants +max_tokens_per_month（0=不限）。新库由 db.js / pg-schema.sql 直接建列；既有库 ALTER 增列（幂等）。
module.exports = {
  id: '0011_stage9_quota_tokens',
  up: async (db) => {
    const pg = db.dialect === 'postgres';
    if (pg) {
      await db.exec('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS max_tokens_per_month INTEGER DEFAULT 0');
    } else {
      const cols = (await db.all('PRAGMA table_info(tenants)')).map(c => c.name);
      if (!cols.includes('max_tokens_per_month')) {
        await db.exec('ALTER TABLE tenants ADD COLUMN max_tokens_per_month INTEGER DEFAULT 0');
      }
    }
  }
};
