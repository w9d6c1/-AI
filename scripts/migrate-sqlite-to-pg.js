// ===== SQLite → Postgres 数据迁移 =====
// 用法：node scripts/migrate-sqlite-to-pg.js
// 依赖：DATABASE_URL（目标 PG）、DB_PATH（源 SQLite，默认 ./data/ecom-ai.db）
// 特性：按外键顺序复制、幂等（ON CONFLICT DO NOTHING）、迁移后重置自增序列并校验行数。
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { Pool } = require('pg');
const { SCHEMA_SQL } = require('../server/db/pg-schema');

// 外键安全顺序
const TABLES = [
  'teams', 'users', 'chats', 'messages', 'agent_runs', 'canvas_boards', 'canvas_elements',
  'competitor_reports', 'tasks', 'task_logs', 'courses', 'course_progress', 'images', 'kb_docs',
  'shop_groups', 'shops', 'user_shop_permissions', 'daily_reports', 'ad_campaigns',
  'suggestions', 'suggestion_items', 'executions', 'collection_tasks', 'audit_logs',
  'collection_schedules', 'schedule_runs', 'alert_rules', 'alerts', 'notification_channels',
  'notifications', 'batch_operations', 'batch_items', 'report_templates', 'report_records',
  'file_assets', 'ai_usage', 'import_batches',
  'products', 'product_daily', 'orders_daily', 'refunds_daily', 'kb_chunks', 'schema_migrations'
];

function columnsOf(sqlite, table) {
  return sqlite.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}

async function migrate({ sqlitePath, databaseUrl, logger = console } = {}) {
  if (!fs.existsSync(sqlitePath)) throw new Error(`源 SQLite 不存在: ${sqlitePath}`);
  if (!databaseUrl) throw new Error('缺少 DATABASE_URL（目标 Postgres）');
  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  const summary = [];
  try {
    await client.query(SCHEMA_SQL);
    await client.query('BEGIN');
    for (const table of TABLES) {
      const exists = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
      if (!exists) continue;
      const cols = columnsOf(sqlite, table);
      const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
      if (!rows.length) { summary.push({ table, rows: 0 }); continue; }
      const placeholders = cols.map((_, i) => '$' + (i + 1)).join(',');
      const quoted = cols.map(c => `"${c}"`).join(',');
      const sql = `INSERT INTO ${table} (${quoted}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
      for (const row of rows) {
        await client.query(sql, cols.map(c => row[c]));
      }
      summary.push({ table, rows: rows.length });
    }
    // 重置序列（仅对拥有 SERIAL 序列的 id 列）
    for (const table of TABLES) {
      const hasId = columnsOf(sqlite, table).includes('id');
      if (!hasId) continue;
      const seq = (await client.query(`SELECT pg_get_serial_sequence('${table}','id') AS s`)).rows[0].s;
      if (!seq) continue;
      await client.query(
        `SELECT setval('${seq}', COALESCE((SELECT MAX(id) FROM ${table}), 1), (SELECT MAX(id) FROM ${table}) IS NOT NULL)`
      );
    }
    await client.query('COMMIT');
    // 校验
    const verify = [];
    for (const table of TABLES) {
      const exists = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
      if (!exists) continue;
      const src = sqlite.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
      const dst = Number((await client.query(`SELECT COUNT(*) c FROM ${table}`)).rows[0].c);
      verify.push({ table, source: src, target: dst, ok: dst >= src });
    }
    const mismatched = verify.filter(v => !v.ok);
    if (mismatched.length) throw new Error('迁移校验失败: ' + JSON.stringify(mismatched));
    logger.log('[migrate] 完成，表行数：');
    for (const s of summary) logger.log(`  ${s.table}: ${s.rows}`);
    return { summary, verify };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    client.release();
    await pool.end();
    sqlite.close();
  }
}

if (require.main === module) {
  const sqlitePath = path.resolve(process.env.DB_PATH || path.join('data', 'ecom-ai.db'));
  migrate({ sqlitePath, databaseUrl: process.env.DATABASE_URL })
    .then(() => console.log('[migrate] 全部完成'))
    .catch(e => { console.error('[migrate] 失败:', e.message); process.exit(1); });
}

module.exports = { migrate, TABLES };
