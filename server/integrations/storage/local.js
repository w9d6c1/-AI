// ===== 本地磁盘存储驱动 =====
const fs = require('fs');
const path = require('path');

const ROOT = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', '..', 'uploads');

function abs(key) {
  const p = path.resolve(ROOT, key);
  const rel = path.relative(ROOT, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('非法存储 key');
  return p;
}

async function put(key, buffer) {
  const p = abs(key);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buffer);
  return { key };
}

async function del(key) {
  try { fs.unlinkSync(abs(key)); } catch (_) { /* ignore */ }
}

// 本地驱动返回规范路径，实际访问仍由 fileAccess（JWT 签名）校验
async function getSignedUrl(key) { return '/uploads/' + key; }

function localPath(key) { return abs(key); }
function isLocal() { return true; }

// 就绪探针：目录可写
async function ping() {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.accessSync(ROOT, fs.constants.W_OK);
  return { ok: true, driver: 'local', root: ROOT };
}

module.exports = { put, del, getSignedUrl, localPath, isLocal, ping, ROOT };
