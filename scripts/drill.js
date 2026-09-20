// ===== 备份恢复演练（SQLite）=====
// 用法：node scripts/drill.js
// 流程：对当前 SQLite 库做一次备份 → 恢复到临时目录 → 校验完整性与关键表行数。
const os = require('os');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { snapshot } = require('./backup');
const { restore } = require('./restore');

const KEY_TABLES = ['tenants', 'users', 'shops', 'daily_reports', 'executions', 'suggestions'];

function drill({ dbPath, dataDir, uploadDir }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecom-drill-'));
  const backupDir = path.join(tmp, 'backup');
  const restoreDir = path.join(tmp, 'restore');
  try {
    snapshot({ dbPath, dataDir, uploadDir, destination: backupDir });
    restore(backupDir, restoreDir);
    const src = new DatabaseSync(dbPath, { readOnly: true });
    const dst = new DatabaseSync(path.join(restoreDir, 'data', 'ecom-ai.db'), { readOnly: true });
    try {
      if (dst.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('恢复库完整性检查失败');
      const counts = {};
      for (const table of KEY_TABLES) {
        const s = src.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
        const d = dst.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
        counts[table] = { source: s, restored: d, ok: s === d };
      }
      const ok = Object.values(counts).every(c => c.ok);
      if (!ok) throw new Error('行数校验不一致: ' + JSON.stringify(counts));
      return { ok: true, counts };
    } finally { src.close(); dst.close(); }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  require('dotenv').config();
  const dataDir = path.resolve(process.env.DATA_DIR || 'data');
  const result = drill({
    dbPath: path.resolve(process.env.DB_PATH || path.join(dataDir, 'ecom-ai.db')),
    dataDir,
    uploadDir: path.resolve(process.env.UPLOAD_DIR || 'uploads')
  });
  console.log('[drill] 备份恢复演练通过:', JSON.stringify(result.counts));
}

module.exports = { drill };
