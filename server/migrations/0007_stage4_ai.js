// ===== 阶段 4：真实 AI 与决策的数据结构 =====
// - suggestions +prompt_version/model/source/excluded_items（建议引擎可追溯）
// - agent_runs +provider/model/tokens_in/tokens_out/cost（用量成本）
// - 新增 kb_chunks（知识库分块检索）
const SQLITE = `
CREATE TABLE IF NOT EXISTS kb_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER NOT NULL,
  doc_id INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  tokens INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON kb_chunks(tenant_id, user_id, doc_id);`;

const PG = `
CREATE TABLE IF NOT EXISTS kb_chunks (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER NOT NULL,
  doc_id INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  tokens INTEGER DEFAULT 0,
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON kb_chunks(tenant_id, user_id, doc_id);`;

module.exports = {
  id: '0007_stage4_ai',
  up: async (db) => {
    const pg = db.dialect === 'postgres';
    await db.exec(pg ? PG : SQLITE);

    const addCol = async (table, column, def) => {
      if (pg) {
        await db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${def}`);
      } else {
        const cols = (await db.all(`PRAGMA table_info(${table})`)).map(c => c.name);
        if (!cols.includes(column)) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
      }
    };

    await addCol('suggestions', 'prompt_version', 'TEXT');
    await addCol('suggestions', 'model', 'TEXT');
    await addCol('suggestions', 'source', 'TEXT');
    await addCol('suggestions', 'excluded_items', 'INTEGER DEFAULT 0');

    await addCol('agent_runs', 'provider', 'TEXT');
    await addCol('agent_runs', 'model', 'TEXT');
    await addCol('agent_runs', 'tokens_in', 'INTEGER DEFAULT 0');
    await addCol('agent_runs', 'tokens_out', 'INTEGER DEFAULT 0');
    await addCol('agent_runs', 'cost', pg ? 'DOUBLE PRECISION DEFAULT 0' : 'REAL DEFAULT 0');
  }
};
