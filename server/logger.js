// ===== 结构化日志（JSON + 大小轮转，零依赖）=====
// 环境变量：LOG_LEVEL(debug|info|warn|error)、LOG_FORMAT(json|text)、LOG_DIR、
//           LOG_MAX_BYTES(默认 10MB)、LOG_MAX_FILES(默认 5)、LOG_CONSOLE(默认 true)、LOG_ENABLED
const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;
const FORMAT = String(process.env.LOG_FORMAT || 'json').toLowerCase();
const ENABLED = process.env.LOG_ENABLED !== 'false';
// 控制台默认只输出 warn/error（避免请求日志刷屏）；LOG_CONSOLE=true 时输出全部级别
const CONSOLE = process.env.LOG_CONSOLE === 'true';
const MAX_BYTES = Number(process.env.LOG_MAX_BYTES || 10 * 1024 * 1024);
const MAX_FILES = Math.max(1, Number(process.env.LOG_MAX_FILES || 5));
const LOG_DIR = process.env.LOG_DIR || path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');

let fd = null;
let bytes = 0;

function ensureFd() {
  if (fd !== null) return fd;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fd = fs.openSync(LOG_FILE, 'a');
  try { bytes = fs.fstatSync(fd).size; } catch (_) { bytes = 0; }
  return fd;
}

// 大小轮转：app.log → app.log.1 → ... → app.log.N
function rotate() {
  try {
    if (fd !== null) { fs.closeSync(fd); fd = null; }
    for (let i = MAX_FILES - 1; i >= 1; i--) {
      const from = i === 1 ? LOG_FILE : `${LOG_FILE}.${i - 1}`;
      const to = `${LOG_FILE}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    bytes = 0;
  } catch (_) { /* 轮转失败不阻断 */ }
}

function fmt(rec) {
  if (FORMAT === 'text') {
    const extra = Object.keys(rec).filter(k => !['ts', 'level', 'msg'].includes(k));
    const tail = extra.length ? ' ' + extra.map(k => `${k}=${JSON.stringify(rec[k])}`).join(' ') : '';
    return `${rec.ts} [${rec.level.toUpperCase()}] ${rec.msg}${tail}`;
  }
  return JSON.stringify(rec);
}

function write(level, msg, fields = {}) {
  if (!ENABLED || LEVELS[level] < LEVEL) return;
  const rec = { ts: new Date().toISOString(), level, msg, ...fields };
  const line = fmt(rec) + '\n';
  try {
    ensureFd();
    if (bytes + Buffer.byteLength(line) > MAX_BYTES) { rotate(); ensureFd(); }
    fs.writeSync(fd, line);
    bytes += Buffer.byteLength(line);
  } catch (_) { /* ignore */ }
  if (CONSOLE || level === 'error' || level === 'warn') {
    const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    out.write(line);
  }
}

function child(bindings = {}) {
  const wrap = (level) => (msg, fields = {}) => write(level, msg, { ...bindings, ...fields });
  return { debug: wrap('debug'), info: wrap('info'), warn: wrap('warn'), error: wrap('error'), child: (b) => child({ ...bindings, ...b }) };
}

module.exports = {
  LEVELS,
  debug: (msg, f) => write('debug', msg, f),
  info: (msg, f) => write('info', msg, f),
  warn: (msg, f) => write('warn', msg, f),
  error: (msg, f) => write('error', msg, f),
  child,
  _paths: { LOG_DIR, LOG_FILE },
  _rotate: rotate
};
