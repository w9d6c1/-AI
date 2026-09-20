const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecom-stage7-'));
Object.assign(process.env, {
  DATA_DIR: path.join(root, 'data'), DB_PATH: path.join(root, 'data/ecom-ai.db'), UPLOAD_DIR: path.join(root, 'uploads'),
  JWT_SECRET: crypto.randomBytes(32).toString('hex'), DB_DRIVER: 'sqlite', LOG_CONSOLE: 'false',
  QUEUE_ENABLED: 'false', STORAGE_DRIVER: 'local', ENABLE_SCHEDULER: 'false',
  SEED_DEFAULT_USERS: 'false', SEED_DEMO_DATA: 'false', ALLOW_REGISTRATION: 'false',
  AI_API_KEY: '', AI_IMAGE_API_KEY: '', AI_PROVIDERS: '',
  PASSWORD_MIN_LENGTH: '12', PASSWORD_HISTORY: '5', LOGIN_MAX_ATTEMPTS: '3', LOGIN_LOCK_MINUTES: '15',
  SCAN_UPLOADS: 'false', LLM_REDACT_PII: 'true'
});

const app = require('../server/index');
const { defaultAdapter } = require('../server/repositories');
const { runWithTenant } = require('../server/repositories/tenant-context');
const { db } = require('../server/db');
const totp = require('../server/security/totp');
const passwords = require('../server/security/passwords');
const compliance = require('../server/compliance');
const { secret } = require('../server/secrets');
const scan = require('../server/security/scan');
const { purgeTenant } = require('../server/retention');

let server, base;
const ADMIN_PW = 'Str0ng-Pass!2026';
const LOCK_PW = 'L0ck-Test!2026x';

before(async () => {
  await runWithTenant(1, async () => {
    const hash = passwords.hash(ADMIN_PW);
    await defaultAdapter.run("INSERT INTO users (tenant_id,username,password_hash,role,password_changed_at) VALUES (?,?,?,?,?)", [1, 'admin', hash, 'admin', '2026-09-01 00:00:00']);
    const h2 = passwords.hash(LOCK_PW);
    await defaultAdapter.run("INSERT INTO users (tenant_id,username,password_hash,role,password_changed_at) VALUES (?,?,?,?,?)", [1, 'locky', h2, 'member', '2026-09-01 00:00:00']);
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;
});

after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  try { db.close(); } catch (_) { /* ignore */ }
  const resolved = path.resolve(root);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('ecom-stage7-')) fs.rmSync(resolved, { recursive: true, force: true });
});

async function post(url, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  return fetch(base + '/api' + url, { method: 'POST', headers, body: JSON.stringify(body) });
}
async function login(username, password, code) {
  const r = await post('/auth/login', { username, password, totp: code });
  return { status: r.status, body: await r.json() };
}

test('TOTP：RFC 6238 向量与窗口校验', () => {
  const secretB32 = totp.base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(secretB32, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(totp.hotp(secretB32, 1, 8), '94287082');
  assert.equal(totp.totp(secretB32, 59000, 30, 6), '287082');
  const s = totp.generateSecret();
  const now = totp.totp(s);
  assert.equal(totp.verify(s, now), true);
  assert.equal(totp.verify(s, '000000'), false);
  assert.ok(totp.otpauthURL(s, 'admin').startsWith('otpauth://totp/'));
  assert.match(totp.generateRecoveryCodes(1)[0], /^[0-9A-F]{5}-[0-9A-F]{5}$/);
});

test('密码策略与历史复用', () => {
  assert.equal(passwords.validate('short').ok, false);
  assert.equal(passwords.validate('alllowercaseonly').ok, false);
  assert.equal(passwords.validate('Str0ng-Pass!2026').ok, true);
  assert.equal(passwords.validate('Admin-Str0ng!2026', { username: 'admin' }).ok, false);
  const h = passwords.hash('Str0ng-Pass!2026');
  assert.equal(passwords.reused('Str0ng-Pass!2026', JSON.stringify([h])), true);
  assert.equal(passwords.reused('Other-Pass!2026', JSON.stringify([h])), false);
  const hist = JSON.parse(passwords.pushHistory(JSON.stringify([h]), 'OLDHASH'));
  assert.equal(hist[0], 'OLDHASH');
});

test('合规：LLM 出境前 PII 脱敏', () => {
  assert.equal(compliance.redactEnabled(), true);
  const out = compliance.redact('联系 13800138000 或 a@b.com，身份证 11010519491231002X');
  assert.ok(!out.includes('13800138000'));
  assert.ok(!out.includes('a@b.com'));
  assert.ok(!out.includes('11010519491231002X'));
  assert.ok(out.includes('1**********'));
});

test('密钥托管：<NAME>_FILE 优先', () => {
  const f = path.join(root, 'jwt.txt');
  fs.writeFileSync(f, '  file-secret-value\n');
  process.env.TEST_SECRET_FILE = f;
  process.env.TEST_SECRET = 'env-value';
  assert.equal(secret('TEST_SECRET'), 'file-secret-value');
  delete process.env.TEST_SECRET_FILE;
  assert.equal(secret('TEST_SECRET'), 'env-value');
  delete process.env.TEST_SECRET;
});

test('上传扫描：未启用跳过；fail-closed 未配置拒绝', async () => {
  process.env.SCAN_UPLOADS = 'false';
  assert.equal((await scan.scanBuffer(Buffer.from('x'), 'a.txt')).skipped, true);
  process.env.SCAN_UPLOADS = 'true';
  process.env.SCAN_FAIL_CLOSED = 'true';
  delete process.env.CLAMAV_HOST;
  const r = await scan.scanBuffer(Buffer.from('x'), 'a.txt');
  assert.equal(r.ok, false);
  process.env.SCAN_UPLOADS = 'false';
  delete process.env.SCAN_FAIL_CLOSED;
});

test('登录：失败锁定与审计', async () => {
  for (let i = 0; i < 3; i++) {
    const r = await login('locky', 'wrong-password');
    assert.ok([401, 423].includes(r.status));
  }
  const locked = await login('locky', LOCK_PW);
  assert.equal(locked.status, 423);
  const events = await runWithTenant(1, () => defaultAdapter.all("SELECT action FROM audit_logs WHERE tenant_id=? AND action IN ('login_failed','login_locked')", [1]));
  assert.ok(events.length >= 1);
});

test('登录：2FA 启用/校验/恢复码 + 审计', async () => {
  const first = await login('admin', ADMIN_PW);
  assert.equal(first.status, 200);
  const token = first.body.token;

  const setup = await (await post('/auth/2fa/setup', {}, token)).json();
  assert.ok(setup.secret && setup.recovery_codes.length === 8);
  const code = totp.totp(setup.secret);
  const verify = await post('/auth/2fa/verify', { code }, token);
  assert.equal(verify.status, 200);

  // 未带验证码 → 需要 2FA
  const noCode = await login('admin', ADMIN_PW);
  assert.equal(noCode.status, 401);
  assert.equal(noCode.body.requires_2fa, true);

  // 带正确验证码 → 成功
  const withCode = await login('admin', ADMIN_PW, totp.totp(setup.secret));
  assert.equal(withCode.status, 200);
  assert.equal(withCode.body.totp_enabled, true);

  // 恢复码可登录
  const rec = await login('admin', ADMIN_PW, setup.recovery_codes[0]);
  assert.equal(rec.status, 200);

  const sec = await (await fetch(base + '/api/auth/security', { headers: { Authorization: 'Bearer ' + withCode.body.token } })).json();
  assert.equal(sec.totp_enabled, true);
  assert.equal(sec.recovery_codes_remaining, 7);
  assert.ok(sec.password_changed_at);
});

test('修改密码：策略/复用校验并轮换 token', async () => {
  const r = await login('admin', ADMIN_PW, totp.totp(await runWithTenant(1, async () => (await defaultAdapter.get('SELECT totp_secret FROM users WHERE username=? AND tenant_id=?', ['admin', 1])).totp_secret)));
  const token = r.body.token;
  const bad = await post('/auth/password', { current_password: 'nope', new_password: 'An0ther-Pass!2026' }, token);
  assert.equal(bad.status, 400);
  const weak = await post('/auth/password', { current_password: ADMIN_PW, new_password: 'short' }, token);
  assert.equal(weak.status, 400);
  const ok = await post('/auth/password', { current_password: ADMIN_PW, new_password: 'An0ther-Pass!2026' }, token);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.ok(body.token, '应返回新 token');
});

test('数据保留：清理超期审计', async () => {
  await runWithTenant(1, async () => {
    await defaultAdapter.run("INSERT INTO audit_logs (tenant_id,user_id,action,created_at) VALUES (?,?,?,?)", [1, null, 'old_event', '2019-01-01 00:00:00']);
  });
  const before = Number((await runWithTenant(1, () => defaultAdapter.get("SELECT COUNT(*) c FROM audit_logs WHERE tenant_id=? AND action='old_event'", [1]))).c);
  assert.equal(before, 1);
  const summary = await purgeTenant(1);
  assert.ok(summary.audit_logs >= 1);
  const after = Number((await runWithTenant(1, () => defaultAdapter.get("SELECT COUNT(*) c FROM audit_logs WHERE tenant_id=? AND action='old_event'", [1]))).c);
  assert.equal(after, 0);
});
