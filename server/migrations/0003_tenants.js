// ===== 多租户：tenants 表 + 全业务表 tenant_id =====
// 现有库通过 ALTER 增列（DEFAULT 1 自动回填历史数据）；新库由 db.js / pg-schema.sql 直接建列。
const TENANT_TABLES = [
  'teams', 'users', 'chats', 'messages', 'agent_runs', 'canvas_boards', 'canvas_elements',
  'competitor_reports', 'tasks', 'task_logs', 'course_progress', 'images', 'kb_docs',
  'shop_groups', 'shops', 'user_shop_permissions', 'daily_reports', 'ad_campaigns',
  'suggestions', 'suggestion_items', 'executions', 'collection_tasks', 'audit_logs',
  'collection_schedules', 'schedule_runs', 'alert_rules', 'alerts', 'notification_channels',
  'notifications', 'batch_operations', 'batch_items', 'report_templates', 'report_records',
  'file_assets'
];

const CREATE_TENANTS = `
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  status TEXT DEFAULT 'active',
  plan TEXT DEFAULT 'trial',
  max_shops INTEGER DEFAULT 50,
  max_ai_calls_per_month INTEGER DEFAULT 100000,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);`;

const CREATE_TENANTS_PG = `
CREATE TABLE IF NOT EXISTS tenants (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  status TEXT DEFAULT 'active',
  plan TEXT DEFAULT 'trial',
  max_shops INTEGER DEFAULT 50,
  max_ai_calls_per_month INTEGER DEFAULT 100000,
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
);`;

module.exports = {
  id: '0003_tenants',
  up: async (db) => {
    const pg = db.dialect === 'postgres';
    await db.exec(pg ? CREATE_TENANTS_PG : CREATE_TENANTS);

    for (const table of TENANT_TABLES) {
      if (pg) {
        await db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1`);
      } else {
        const cols = (await db.all(`PRAGMA table_info(${table})`)).map(c => c.name);
        if (!cols.includes('tenant_id')) {
          await db.exec(`ALTER TABLE ${table} ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1`);
        }
      }
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_tenant ON ${table}(tenant_id)`);
    }

    if (pg) {
      await db.exec(
        `INSERT INTO tenants (id, name, slug, status, plan) VALUES (1, '默认租户', 'default', 'active', 'internal')
         ON CONFLICT (id) DO NOTHING`
      );
      await db.exec(
        `SELECT setval(pg_get_serial_sequence('tenants','id'), GREATEST((SELECT MAX(id) FROM tenants), 1))`
      );
    } else {
      await db.exec(
        `INSERT OR IGNORE INTO tenants (id, name, slug, status, plan) VALUES (1, '默认租户', 'default', 'active', 'internal')`
      );
    }
  }
};
