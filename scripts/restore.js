const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { digest } = require('./backup');
function restore(source, destination) {
  source = path.resolve(source); destination = path.resolve(destination);
  if (fs.existsSync(destination)) throw new Error('恢复目标必须是尚不存在的新目录，禁止覆盖运行数据');
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.some(f => f.path === 'ecom-ai.db')) throw new Error('无效备份清单');
  for (const item of manifest.files) {
    const src = path.resolve(source, item.path), rel = path.relative(source, src);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || fs.lstatSync(src).isSymbolicLink() || digest(src) !== item.sha256) throw new Error('备份文件校验失败: ' + item.path);
  }
  fs.mkdirSync(destination, { recursive: true });
  for (const item of manifest.files) {
    const target = path.join(destination, item.path === 'ecom-ai.db' ? 'data/ecom-ai.db' : item.path.startsWith('reports/') ? 'data/' + item.path : item.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source, item.path), target);
  }
  fs.mkdirSync(path.join(destination, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(destination, 'data/reports'), { recursive: true });
  const db = new DatabaseSync(path.join(destination, 'data/ecom-ai.db'));
  try {
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('恢复后数据库完整性检查失败');
    for (const r of db.prepare('SELECT id,file_path FROM report_records WHERE file_path IS NOT NULL').all()) {
      const fileName = path.win32.basename(r.file_path.replaceAll('/', '\\'));
      db.prepare('UPDATE report_records SET file_path=? WHERE id=?').run(fileName, r.id);
    }
  } finally { db.close(); }
  return destination;
}
if (require.main === module) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('用法: node scripts/restore.js 备份目录 新恢复目录');
  console.log(restore(process.argv[2], process.argv[3]));
}
module.exports = { restore };
