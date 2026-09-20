// ===== 仓储层入口 =====
// 通过适配器（sqlite / postgres）暴露领域仓储，所有方法异步。
// ctx = { tenantId } 为多租户上下文，阶段 3 起由中间件注入并强制过滤。
// 驱动选择：DB_DRIVER=sqlite(默认) | postgres；Postgres 使用 DATABASE_URL。
const { createRepositories } = require('./factory');

function buildAdapter() {
  const driver = String(process.env.DB_DRIVER || 'sqlite').toLowerCase();
  if (driver === 'postgres' || driver === 'pg') {
    const { PostgresAdapter } = require('./postgres/adapter');
    return new PostgresAdapter();
  }
  // 仅 sqlite 模式才打开 SQLite 文件（避免 PG 模式误开/权限问题）
  const { db } = require('../db');
  const { SqliteAdapter } = require('./sqlite/adapter');
  return new SqliteAdapter(db);
}

const defaultAdapter = buildAdapter();
const repos = createRepositories(defaultAdapter);

module.exports = { createRepositories, repos, defaultAdapter, buildAdapter };
