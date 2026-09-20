const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecom-intg-'));
Object.assign(process.env, {
  DATA_DIR: path.join(root, 'data'), DB_PATH: path.join(root, 'data/ecom-ai.db'), UPLOAD_DIR: path.join(root, 'uploads'),
  JWT_SECRET: crypto.randomBytes(32).toString('hex'), DB_DRIVER: 'sqlite',
  QUEUE_ENABLED: 'false', STORAGE_DRIVER: 'local', CB_THRESHOLD: '2', CB_COOLDOWN_MS: '60000',
  AI_API_KEY: 'k1', AI_IMAGE_API_KEY: 'k2',
  AI_PROVIDERS: JSON.stringify([
    { id: 'p1', priority: 1, caps: ['chat'], baseUrl: 'https://a.example/v1', apiKeyEnv: 'AI_API_KEY', model: 'm1', maxRetries: 0 },
    { id: 'p2', priority: 2, caps: ['chat', 'image'], baseUrl: 'https://b.example/v1', apiKeyEnv: 'AI_IMAGE_API_KEY', model: 'm2', imageModel: 'img2', maxRetries: 0 }
  ])
});

const storage = require('../server/integrations/storage');
const registry = require('../server/integrations/registry');
const breaker = require('../server/integrations/registry/breaker');
const queue = require('../server/queue');

test('存储抽象（local）：put / 路径 / 签名 / 删除', async () => {
  const key = 'generated/test_file.txt';
  await storage.put(key, Buffer.from('hello'), 'text/plain');
  assert.equal(storage.isLocal(), true);
  assert.ok(fs.existsSync(storage.localPath(key)));
  assert.equal(await storage.getSignedUrl(key), '/uploads/' + key);
  await storage.del(key);
  assert.equal(fs.existsSync(storage.localPath(key)), false);
  await assert.rejects(() => storage.put('../escape.txt', Buffer.from('x')), /非法存储 key/);
});

test('队列：未启用时 enqueue 返回 false（走同步回退）', async () => {
  assert.equal(queue.enabled(), false);
  assert.equal(await queue.enqueue('collect', { x: 1 }), false);
});

test('ProviderRegistry：优先级排序、能力路由、密钥解析', () => {
  const all = registry.describe();
  assert.equal(all.length, 2);
  assert.deepEqual(all.map(p => p.id), ['p1', 'p2']);
  assert.equal(registry.hasCapability('chat'), true);
  assert.equal(registry.hasCapability('image'), true);
  const chat = all.filter(p => p.caps.includes('chat'));
  const image = all.filter(p => p.caps.includes('image'));
  assert.equal(chat.length, 2);
  assert.equal(image.length, 1);
  assert.equal(image[0].id, 'p2');
  assert.equal(chat[0].has_chat_key, true);
});

test('ProviderRegistry：首选失败自动切下一源', async () => {
  const orig = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('a.example')) return { ok: false, status: 500, text: async () => 'boom' };
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok-from-p2' } }], usage: { prompt_tokens: 3, completion_tokens: 4 }, model: 'm2' }) };
  };
  try {
    const r = await registry.callChat([{ role: 'user', content: 'hi' }]);
    assert.equal(r.content, 'ok-from-p2');
    assert.equal(r.provider, 'p2');
    assert.ok(calls.some(u => u.includes('a.example')));
    assert.ok(calls.some(u => u.includes('b.example')));
  } finally { global.fetch = orig; }
});

test('熔断器（无 Redis，内存）：达阈值后打开', async () => {
  await breaker.onSuccess('cb-test');
  assert.equal(await breaker.isOpen('cb-test'), false);
  await breaker.onFailure('cb-test');
  assert.equal(await breaker.isOpen('cb-test'), false);
  await breaker.onFailure('cb-test');
  assert.equal(await breaker.isOpen('cb-test'), true);
  await breaker.onSuccess('cb-test');
  assert.equal(await breaker.isOpen('cb-test'), false);
});

after(() => {
  try { require('../server/db').db.close(); } catch (_) { /* ignore */ }
  const resolved = path.resolve(root);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('ecom-intg-')) fs.rmSync(resolved, { recursive: true, force: true });
});
