// ===== 运维补充：通知故障转移 / Provider 热更新 / 存储契约别名 =====
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecom-ops-'));
Object.assign(process.env, {
  DATA_DIR: path.join(root, 'data'), DB_PATH: path.join(root, 'data/ecom-ai.db'), UPLOAD_DIR: path.join(root, 'uploads'),
  JWT_SECRET: crypto.randomBytes(32).toString('hex'), DB_DRIVER: 'sqlite',
  QUEUE_ENABLED: 'false', STORAGE_DRIVER: 'local', ENABLE_SCHEDULER: 'false', LOG_CONSOLE: 'false',
  NOTIFY_MODE: 'failover', AI_API_KEY: '', AI_IMAGE_API_KEY: '',
  AI_PROVIDERS: JSON.stringify([{ id: 'p1', priority: 1, caps: ['chat'], baseUrl: 'https://a/v1', apiKey: 'k', model: 'm1' }])
});

const { db } = require('../server/db');
const { defaultAdapter } = require('../server/repositories');
const { runWithTenant } = require('../server/repositories/tenant-context');
const { sendNotifications } = require('../server/notifier');
const registry = require('../server/integrations/registry');
const storage = require('../server/integrations/storage');

const origFetch = global.fetch;

after(() => {
  global.fetch = origFetch;
  try { db.close(); } catch (_) { /* ignore */ }
  const resolved = path.resolve(root);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('ecom-ops-')) fs.rmSync(resolved, { recursive: true, force: true });
});

test('通知 failover：按优先级降级，成功后不再尝试后续渠道', async () => {
  const calls = [];
  global.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('fail.example')) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, json: async () => ({}) };
  };
  try {
    await runWithTenant(1, async () => {
      const alertId = (await defaultAdapter.run("INSERT INTO alerts (tenant_id,shop_id,alert_type,severity,title,message,triggered_at) VALUES (?,?,?,?,?,?,?)", [1, null, 'test', 'warning', '预警', 'msg', '2026-09-21 10:00:00'])).lastInsertRowid;
      await defaultAdapter.run("INSERT INTO notification_channels (tenant_id,name,channel_type,webhook_url,enabled) VALUES (?,?,?,?,?)", [1, '坏钩子', 'dingtalk', 'https://fail.example/x', 1]);
      await defaultAdapter.run("INSERT INTO notification_channels (tenant_id,name,channel_type,webhook_url,enabled) VALUES (?,?,?,?,?)", [1, '好钩子', 'dingtalk', 'https://ok.example/x', 1]);
      await defaultAdapter.run("INSERT INTO notification_channels (tenant_id,name,channel_type,enabled) VALUES (?,?,?,?)", [1, '短信', 'sms', 1]);

      await sendNotifications(alertId);
      const rows = await defaultAdapter.all('SELECT status, error_msg FROM notifications WHERE tenant_id=? AND alert_id=? ORDER BY id', [1, alertId]);
      assert.equal(rows.length, 2, '应只尝试前两个渠道');
      assert.equal(rows[0].status, 'failed');
      assert.equal(rows[1].status, 'sent');
      assert.ok(calls.some(u => u.includes('fail.example')));
      assert.ok(calls.some(u => u.includes('ok.example')));
    });
  } finally { global.fetch = origFetch; }
});

test('Provider 热更新：reloadProviders 生效', () => {
  assert.deepEqual(registry.describe().map(p => p.id), ['p1']);
  process.env.AI_PROVIDERS = JSON.stringify([
    { id: 'x1', priority: 1, caps: ['chat', 'image'], baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' },
    { id: 'x2', priority: 2, caps: ['chat'], baseUrl: 'https://y/v1', apiKey: 'k', model: 'm' }
  ]);
  registry.reloadProviders();
  assert.deepEqual(registry.describe().map(p => p.id), ['x1', 'x2']);
  assert.equal(registry.hasCapability('image'), true);
});

test('存储契约别名：delete 与 del 等价', async () => {
  assert.equal(typeof storage.delete, 'function');
  await storage.put('tmp/alias.txt', Buffer.from('x'), 'text/plain');
  await storage.delete('tmp/alias.txt');
  assert.equal(fs.existsSync(storage.localPath('tmp/alias.txt')), false);
});
