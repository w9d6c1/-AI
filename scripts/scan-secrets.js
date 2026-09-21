// ===== 泄露密钥扫描（仅扫描 git 跟踪文件）=====
// 用途：轮换密钥后确认仓库中无残留明文密钥。
// 用法：node scripts/scan-secrets.js [根目录]
// 退出码：0=无发现；1=发现疑似泄露。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PATTERNS = [
  { name: 'OpenAI/DeepSeek key', re: /sk-[A-Za-z0-9]{16,}/g },
  { name: '火山方舟 key', re: /ark-[A-Za-z0-9-]{16,}/g },
  { name: '私钥', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'AWS AccessKey', re: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    name: '敏感赋值',
    // 值限定为 20+ 位的密钥样式（无点号/括号，避免命中 `crypto.randomBytes(...)`）；排除 `${VAR}` 插值
    re: /(?<!\$\{)\b(JWT_SECRET|RPA_CALLBACK_TOKEN|RPA_APP_SECRET|AI_API_KEY|AI_IMAGE_API_KEY|SMTP_PASS|S3_SECRET_KEY|S3_ACCESS_KEY|DB_PASSWORD|PG_PASSWORD)\b\s*[=:]\s*["']?([A-Za-z0-9_\-]{20,})/g,
    requireDigit: true
  }
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'uploads', 'backups', '.playwright-mcp', '_dev-archive']);
const SKIP_FILES = new Set(['.env', '.env.local', '.env.production']); // 真实配置，允许含密钥
const SKIP_EXT = new Set(['.log', '.db', '.dump', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.zip', '.gz', '.woff', '.woff2']);

function mask(s) {
  return String(s).replace(/[A-Za-z0-9_\-./+]{16,}/g, '***');
}

function scanText(text, { includeAssignments = true } = {}) {
  const findings = [];
  const lines = String(text).split(/\r?\n/);
  for (const p of PATTERNS) {
    if (p.name === '敏感赋值' && !includeAssignments) continue; // 测试夹具常含占位密钥
    lines.forEach((line, i) => {
      const re = new RegExp(p.re.source, p.re.flags);
      let m;
      while ((m = re.exec(line))) {
        if (p.requireDigit && m[2] && !/[0-9]/.test(m[2])) { re.lastIndex = m.index + 1; continue; }
        findings.push({ type: p.name, line: i + 1, excerpt: mask(line.trim()).slice(0, 120) });
        if (re.lastIndex <= m.index) re.lastIndex = m.index + 1;
      }
    });
  }
  return findings;
}

function listFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString('utf8');
    if (out) return out.split('\0').filter(Boolean);
  } catch (_) { /* 非 git 仓库，回退遍历 */ }
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name)); continue; }
      files.push(path.relative(root, path.join(dir, e.name)).split(path.sep).join('/'));
    }
  })(root);
  return files;
}

function scanRepo(root = process.cwd()) {
  const findings = [];
  for (const rel of listFiles(root)) {
    if (SKIP_FILES.has(path.basename(rel))) continue;
    if (SKIP_EXT.has(path.extname(rel).toLowerCase())) continue;
    let text;
    try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch (_) { continue; }
    const isTest = /(^|\/)test\//.test(rel);
    for (const f of scanText(text, { includeAssignments: !isTest })) findings.push({ file: rel, ...f });
  }
  return findings;
}

if (require.main === module) {
  const root = process.argv[2] || process.cwd();
  const findings = scanRepo(root);
  if (!findings.length) {
    console.log('[scan-secrets] 未发现疑似泄露密钥 ✅');
    process.exit(0);
  }
  console.error(`[scan-secrets] 发现 ${findings.length} 处疑似泄露：`);
  for (const f of findings) console.error(`  ${f.file}:${f.line} [${f.type}] ${f.excerpt}`);
  process.exit(1);
}

module.exports = { PATTERNS, scanText, scanRepo, listFiles, mask };
