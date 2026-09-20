// ===== AI 用量/成本表 =====
const SQLITE = `
CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  provider TEXT,
  capability TEXT,
  model TEXT,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  cost REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);`;

const PG = `
CREATE TABLE IF NOT EXISTS ai_usage (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  provider TEXT,
  capability TEXT,
  model TEXT,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  cost DOUBLE PRECISION DEFAULT 0,
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
);`;

module.exports = {
  id: '0004_ai_usage',
  up: async (db) => {
    await db.exec(db.dialect === 'postgres' ? PG : SQLITE);
    await db.exec('CREATE INDEX IF NOT EXISTS idx_ai_usage_tenant ON ai_usage(tenant_id)');
  }
};
