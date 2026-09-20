// ===== Postgres 基础 Schema 引导 =====
// 读取 pg-schema.sql 并执行（全部为 CREATE TABLE IF NOT EXISTS，可重复运行）。
const fs = require('fs');
const path = require('path');

const SCHEMA_PATH = path.join(__dirname, 'pg-schema.sql');
const SCHEMA_SQL = fs.readFileSync(SCHEMA_PATH, 'utf8');

async function bootstrapPostgres(adapter) {
  if (!adapter || adapter.dialect !== 'postgres') return false;
  await adapter.exec(SCHEMA_SQL);
  return true;
}

module.exports = { bootstrapPostgres, SCHEMA_SQL, SCHEMA_PATH };
