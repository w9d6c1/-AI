const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { scanText, scanRepo } = require('../scripts/scan-secrets');

test('scanText：命中各类密钥模式', () => {
  const text = [
    'const k = "sk-abcdefghijklmnop1234";',
    'ark-12345678-1234-1234-1234-1234567890ab',
    '-----BEGIN RSA PRIVATE KEY-----',
    'AI_API_KEY=abcdefghij0123456789'
  ].join('\n');
  const findings = scanText(text);
  const types = findings.map(f => f.type);
  assert.ok(types.includes('OpenAI/DeepSeek key'));
  assert.ok(types.includes('火山方舟 key'));
  assert.ok(types.includes('私钥'));
  assert.ok(types.includes('敏感赋值'));
  assert.equal(findings.find(f => f.type === 'OpenAI/DeepSeek key').line, 1);
});

test('scanText：不误报代码与环境变量插值', () => {
  const text = [
    "JWT_SECRET: crypto.randomBytes(32).toString('hex'),",
    'DATABASE_URL: postgres://${PG_USER:-ecom}:${PG_PASSWORD:-secret}@pg/db'
  ].join('\n');
  assert.deepEqual(scanText(text), []);
  // 测试目录下跳过「敏感赋值」规则（夹具含占位密钥）
  assert.deepEqual(scanText("RPA_CALLBACK_TOKEN: 'stage2-callback-token',", { includeAssignments: false }), []);
});

test('scanRepo：能发现临时目录中植入的密钥', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecom-scan-'));
  try {
    fs.writeFileSync(path.join(root, 'leak.txt'), 'AI_IMAGE_API_KEY=ark-12345678-1234-1234-1234-1234567890ab\n');
    const findings = scanRepo(root);
    assert.ok(findings.some(f => f.file === 'leak.txt'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('scanRepo：当前仓库无残留明文密钥（回归护栏）', () => {
  const findings = scanRepo(process.cwd());
  assert.deepEqual(findings, [], '发现疑似泄露：' + JSON.stringify(findings));
});
