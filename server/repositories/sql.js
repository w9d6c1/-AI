// ===== SQL 方言辅助 =====
// 让业务代码用一套写法同时适配 SQLite 与 Postgres。
const { requireTenant } = require('./tenant-context');

// 当前请求租户；写入/查询租户表时用作 tenant_id 参数
function tenantId() {
  return requireTenant();
}

function nowExpr(dialect) {
  return dialect === 'postgres' ? "to_char(now(),'YYYY-MM-DD HH24:MI:SS')" : "datetime('now','localtime')";
}

function todayExpr(dialect) {
  return dialect === 'postgres' ? "to_char(now(),'YYYY-MM-DD')" : "date('now','localtime')";
}

function placeholders(n) {
  return Array.from({ length: n }, () => '?').join(',');
}

// 幂等写入：SQLite 用 INSERT OR REPLACE；Postgres 用 ON CONFLICT ... DO UPDATE
function upsertSql(dialect, table, columns, conflictColumns, updateColumns = columns) {
  const cols = columns.join(',');
  const ph = placeholders(columns.length);
  if (dialect === 'postgres') {
    const sets = updateColumns.map(c => `${c}=EXCLUDED.${c}`).join(',');
    return `INSERT INTO ${table} (${cols}) VALUES (${ph}) ON CONFLICT (${conflictColumns.join(',')}) DO UPDATE SET ${sets}`;
  }
  return `INSERT OR REPLACE INTO ${table} (${cols}) VALUES (${ph})`;
}

// 忽略冲突写入：SQLite 用 INSERT OR IGNORE；Postgres 用 ON CONFLICT DO NOTHING
function insertIgnoreSql(dialect, table, columns, conflictColumns) {
  const cols = columns.join(',');
  const ph = placeholders(columns.length);
  if (dialect === 'postgres') {
    const target = conflictColumns && conflictColumns.length ? ` (${conflictColumns.join(',')})` : '';
    return `INSERT INTO ${table} (${cols}) VALUES (${ph}) ON CONFLICT${target} DO NOTHING`;
  }
  return `INSERT OR IGNORE INTO ${table} (${cols}) VALUES (${ph})`;
}

// 按「YYYY-MM-DD%」前缀匹配某天（替代 SQLite 的 date(x)=date('now')）
function dayPrefix(dateStr) {
  return String(dateStr).slice(0, 10) + '%';
}

module.exports = { nowExpr, todayExpr, upsertSql, insertIgnoreSql, dayPrefix, tenantId };
