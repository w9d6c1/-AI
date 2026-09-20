// ===== collection_tasks 约束补齐 =====
// 新增 retry_count 列；Postgres 额外补 UNIQUE(shop_id, task_date) 以支持 upsert。
module.exports = {
  id: '0002_collection_tasks_constraints',
  up: async (db) => {
    if (db.dialect === 'postgres') {
      await db.exec('ALTER TABLE collection_tasks ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0');
      const c = await db.get("SELECT 1 AS ok FROM pg_constraint WHERE conname='collection_tasks_shop_date_key'");
      if (!c) {
        await db.exec('ALTER TABLE collection_tasks ADD CONSTRAINT collection_tasks_shop_date_key UNIQUE (shop_id, task_date)');
      }
    } else {
      const cols = (await db.all('PRAGMA table_info(collection_tasks)')).map(c => c.name);
      if (!cols.includes('retry_count')) {
        await db.exec('ALTER TABLE collection_tasks ADD COLUMN retry_count INTEGER DEFAULT 0');
      }
    }
  }
};
