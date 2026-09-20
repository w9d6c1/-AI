// ===== Postgres 恢复（pg_restore）=====
// 用法：node scripts/restore-pg.js <备份目录> <DATABASE_URL>
// 注意：pg_restore --clean 会覆盖目标库对象，请确认目标是可恢复环境。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function digest(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function restorePg(source, databaseUrl) {
  source = path.resolve(source);
  if (!databaseUrl) throw new Error('缺少 DATABASE_URL');
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
  if (!manifest.database || manifest.database.db !== 'postgres') throw new Error('该备份不是 Postgres 备份');
  const dumpName = manifest.database.dump || 'ecom-ai.dump';
  const dump = path.join(source, dumpName);
  if (!fs.existsSync(dump)) throw new Error('备份文件不存在: ' + dumpName);
  const item = (manifest.files || []).find(f => f.path === dumpName);
  if (item && digest(dump) !== item.sha256) throw new Error('备份文件校验失败: ' + dumpName);
  try {
    execFileSync('pg_restore', ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--dbname', databaseUrl, dump], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    throw new Error('pg_restore 失败: ' + (e.stderr ? e.stderr.toString().slice(0, 300) : e.message));
  }
  return dump;
}

if (require.main === module) {
  require('dotenv').config();
  if (!process.argv[2]) throw new Error('用法: node scripts/restore-pg.js <备份目录> [DATABASE_URL]');
  console.log(restorePg(process.argv[2], process.argv[3] || process.env.DATABASE_URL));
}

module.exports = { restorePg };
