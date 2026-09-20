// ===== 备份：SQLite（VACUUM INTO）/ Postgres（pg_dump）+ 文件 + 异地副本 =====
// 用法：
//   node scripts/backup.js [目标目录]
//   DB_DRIVER=postgres DATABASE_URL=... node scripts/backup.js [目标目录]
// 异地：设置 OFFSITE_BACKUP_DIR 后，备份完成后复制一份到该目录。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

function digest(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function inventory(root, dir = root) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) throw new Error('备份不接受符号链接');
    return e.isDirectory() ? inventory(root, p) : [{ path: path.relative(root, p).split(path.sep).join('/'), sha256: digest(p) }];
  });
}

function backupSqlite(dbPath, destination) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    const output = path.join(destination, 'ecom-ai.db').replaceAll("'", "''");
    db.exec(`VACUUM INTO '${output}'`);
  } finally { db.close(); }
  const check = new DatabaseSync(path.join(destination, 'ecom-ai.db'), { readOnly: true });
  try { if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('数据库完整性检查失败'); }
  finally { check.close(); }
  return { db: 'sqlite', dump: 'ecom-ai.db' };
}

function backupPostgres(databaseUrl, destination) {
  const dump = path.join(destination, 'ecom-ai.dump');
  try {
    execFileSync('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', dump, databaseUrl], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    throw new Error('pg_dump 失败（请确认已安装 postgresql-client）: ' + (e.stderr ? e.stderr.toString().slice(0, 300) : e.message));
  }
  const stat = fs.statSync(dump);
  if (!stat.size) throw new Error('pg_dump 产物为空');
  return { db: 'postgres', dump: 'ecom-ai.dump', size: stat.size };
}

function snapshot({ dbPath, dataDir, uploadDir, destination, databaseUrl, driver } = {}) {
  if (fs.existsSync(destination)) throw new Error('备份目录已存在，拒绝覆盖');
  fs.mkdirSync(destination, { recursive: true });

  const usePg = String(driver || '').toLowerCase() === 'postgres' || (!driver && !!databaseUrl);
  const dbMeta = usePg
    ? backupPostgres(databaseUrl, destination)
    : backupSqlite(dbPath, destination);

  for (const [source, folder] of [[uploadDir, 'uploads'], [path.join(dataDir, 'reports'), 'reports']]) {
    if (fs.existsSync(source)) { inventory(source); fs.cpSync(source, path.join(destination, folder), { recursive: true }); }
    else fs.mkdirSync(path.join(destination, folder));
  }

  fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify({
    version: 1,
    createdAt: new Date().toISOString(),
    database: dbMeta,
    files: inventory(destination)
  }, null, 2));

  // 异地副本
  const offsite = process.env.OFFSITE_BACKUP_DIR;
  if (offsite) {
    const target = path.join(path.resolve(offsite), path.basename(destination));
    if (fs.existsSync(target)) throw new Error('异地备份目录已存在，拒绝覆盖: ' + target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(destination, target, { recursive: true });
  }
  return destination;
}

if (require.main === module) {
  require('dotenv').config();
  const dataDir = path.resolve(process.env.DATA_DIR || 'data');
  const destination = path.resolve(process.argv[2] || path.join('backups', new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex')));
  const driver = process.env.DB_DRIVER || 'sqlite';
  const databaseUrl = process.env.DATABASE_URL || '';
  const result = snapshot({
    dbPath: path.resolve(process.env.DB_PATH || path.join(dataDir, 'ecom-ai.db')),
    dataDir,
    uploadDir: path.resolve(process.env.UPLOAD_DIR || 'uploads'),
    destination,
    databaseUrl,
    driver
  });
  console.log(result);
  if (process.env.OFFSITE_BACKUP_DIR) console.log('异地副本 →', path.join(path.resolve(process.env.OFFSITE_BACKUP_DIR), path.basename(destination)));
}

module.exports = { snapshot, inventory, digest };
