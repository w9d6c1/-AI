// ===== Postgres 备份→恢复→行数校验演练（异机演练/上线前自检）=====
// 用法：DATABASE_URL=postgres://... node scripts/drill-pg.js
// 依赖：pg_dump / pg_restore / createdb / dropdb（postgresql-client）
// 流程：pg_dump 源库 → createdb 临时库 → pg_restore → 逐表行数比对 → 删除临时库。
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');

const KEY_TABLES = ['tenants', 'users', 'shops', 'daily_reports', 'executions', 'suggestions'];

function hasCmd(cmd) {
  try { execFileSync(cmd, ['--version'], { stdio: 'ignore' }); return true; } catch (_) { return false; }
}

function run(cmd, args) {
  try { return execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
  catch (e) { throw new Error(`${cmd} 失败: ${e.stderr ? e.stderr.toString().slice(0, 300) : e.message}`); }
}

async function drill() {
  const src = process.env.DATABASE_URL;
  if (!src) throw new Error('缺少 DATABASE_URL');
  for (const c of ['pg_dump', 'pg_restore', 'createdb', 'dropdb']) {
    if (!hasCmd(c)) throw new Error(`缺少命令 ${c}，请安装 postgresql-client`);
  }

  const scratch = process.env.PG_DRILL_DB || `ecom_drill_${Date.now()}`;
  const admin = new URL(src); admin.pathname = '/postgres';
  const target = new URL(src); target.pathname = '/' + scratch;
  const dump = path.join(os.tmpdir(), `${scratch}.dump`);

  console.log(`[drill-pg] 备份源库 → ${dump}`);
  run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', dump, src]);

  console.log(`[drill-pg] 创建临时库 ${scratch}`);
  run('createdb', [`--maintenance-db=${admin.toString()}`, scratch]);

  try {
    console.log('[drill-pg] 恢复到临时库');
    run('pg_restore', ['--no-owner', '--no-privileges', '--dbname', target.toString(), dump]);

    const srcPool = new Pool({ connectionString: src });
    const dstPool = new Pool({ connectionString: target.toString() });
    try {
      const counts = {};
      for (const table of KEY_TABLES) {
        const s = Number((await srcPool.query(`SELECT COUNT(*) c FROM ${table}`)).rows[0].c);
        const d = Number((await dstPool.query(`SELECT COUNT(*) c FROM ${table}`)).rows[0].c);
        counts[table] = { source: s, restored: d, ok: s === d };
      }
      const ok = Object.values(counts).every(c => c.ok);
      if (!ok) throw new Error('行数不一致: ' + JSON.stringify(counts));
      return counts;
    } finally {
      await srcPool.end();
      await dstPool.end();
    }
  } finally {
    try { run('dropdb', [`--maintenance-db=${admin.toString()}`, scratch]); } catch (e) { console.warn('[drill-pg] 清理临时库失败:', e.message); }
    try { fs.unlinkSync(dump); } catch (_) { /* ignore */ }
  }
}

if (require.main === module) {
  drill()
    .then(counts => { console.log('[drill-pg] 备份恢复演练通过:', JSON.stringify(counts)); })
    .catch(e => { console.error('[drill-pg] 失败:', e.message); process.exit(1); });
}

module.exports = { drill };
