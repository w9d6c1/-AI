// ===== 阶段 9 · 多租户运营回归（租户计费/配额、平台总览、用量、代登录、成本配额）=====
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecom-stage9-'));
Object.assign(process.env, {
  DATA_DIR: path.join(root, 'data'), DB_PATH: path.join(root, 'data/ecom-ai.db'), UPLOAD_DIR: path.join(root, 'uploads'),
  JWT_SECRET: crypto.randomBytes(32).toString('hex'), RPA_CALLBACK_TOKEN: 'stage9-token',
  DB_DRIVER: 'sqlite', RPA_MOCK_MODE: 'true', EXECUTOR_DRIVER: 'manual', AUTO_EXECUTE_ENABLED: 'false',
  QUEUE_ENABLED: 'false', STORAGE_DRIVER: 'local', ENABLE_SCHEDULER: 'false',
  SEED_DEFAULT_USERS: 'false', SEED_DEMO_DATA: 'false', ALLOW_REGISTRATION: 'false',
  AI_API_KEY: '', AI_IMAGE_API_KEY: '', AI_PROVIDERS: ''
});

const app = require('../server/index');
const { defaultAdapter } = require('../server/repositories');
const { runWithTenant } = require('../server/repositories/tenant-context');
const { signToken } = require('../server/middleware');
const { db } = require('../server/db');

let server, base, superToken, adminToken, t2Token;
let superId, adminId, tenant2, t2UserId;

before(async () => {
  await runWithTenant(1, async () => {
    superId = (await defaultAdapter.run('INSERT INTO users (tenant_id,username,password_hash,role) VALUES (?,?,?,?)', [1, 'root', bcrypt.hashSync('x', 4), 'superadmin'])).lastInsertRowid;
    adminId = (await defaultAdapter.run('INSERT INTO users (tenant_id,username,password_hash,role) VALUES (?,?,?,?)', [1, 'admin', bcrypt.hashSync('x', 4), 'admin'])).lastInsertRowid;
    superToken = await signToken({ id: superId, role: 'superadmin', session_version: 0 });
    adminToken = await signToken({ id: adminId, tenant_id: 1, session_version: 0 });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;

  // 建「配额租户」：成本上限极小，并预置当月 AI 成本
  const created = await (await req('/admin/tenants', 'POST', {
    name: '配额租户', slug: 'quota-tenant', plan: 'basic',
    max_shops: 5, max_ai_calls_per_month: 1000, max_cost_per_month: 0.01, price_per_month: 99
  }, superToken)).json();
  tenant2 = created.tenant.id;

  const u = await (await req('/admin/tenants/' + tenant2 + '/users', 'POST', { username: 'q_user', password: 'Passw0rd!2345', role: 'admin' }, superToken)).json();
  t2UserId = u.id;
  t2Token = await signToken({ id: t2UserId, tenant_id: tenant2, session_version: 0 });

  await runWithTenant(tenant2, async () => {
    await defaultAdapter.run('INSERT INTO ai_usage (tenant_id,provider,capability,model,tokens_in,tokens_out,cost) VALUES (?,?,?,?,?,?,?)', [tenant2, 'local', 'chat', 'm1', 10, 20, 0.05]);
  });
});

after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  try { db.close(); } catch (_) { /* ignore */ }
  const resolved = path.resolve(root);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('ecom-stage9-')) fs.rmSync(resolved, { recursive: true, force: true });
});

async function req(url, method = 'GET', body, tok = superToken) {
  const headers = { Authorization: 'Bearer ' + tok };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(base + '/api' + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function json(resp, status = 200) { assert.equal(resp.status, status, await resp.clone().text()); return resp.json(); }

test('S9 租户开通：计费/配额字段落库并可更新', async () => {
  const created = await json(await req('/admin/tenants', 'POST', {
    name: '客户A', slug: 'customer-a', plan: 'pro',
    max_shops: 10, max_ai_calls_per_month: 5000, max_cost_per_month: 100,
    price_per_month: 299, billing_cycle: 'monthly', trial_ends_at: '2026-12-31',
    contact_name: '张三', contact_email: 'a@example.com'
  }), 201);
  const id = created.tenant.id;
  assert.equal(created.tenant.max_cost_per_month, 100);
  assert.equal(created.tenant.price_per_month, 299);
  assert.equal(created.tenant.billing_cycle, 'monthly');
  assert.equal(created.tenant.contact_name, '张三');

  const patched = await json(await req('/admin/tenants/' + id, 'PATCH', { status: 'suspended', max_cost_per_month: 50 }));
  assert.equal(patched.tenant.status, 'suspended');
  assert.equal(patched.tenant.max_cost_per_month, 50);

  const list = await json(await req('/admin/tenants'));
  assert.ok(list.tenants.some(t => t.id === id && Number(t.price_per_month) === 299));
});

test('S9 平台总览：租户/店铺/用户/本月成本/MRR', async () => {
  const d = await json(await req('/admin/overview'));
  assert.ok(d.tenants.total >= 2);
  assert.ok(d.tenants.active >= 1);
  assert.equal(typeof d.shops, 'number');
  assert.equal(typeof d.users, 'number');
  assert.ok(d.ai && typeof d.ai.cost === 'number');
  assert.ok(typeof d.mrr === 'number');
});

test('S9 租户用量与用户列表', async () => {
  const u = await json(await req('/admin/tenants/' + tenant2 + '/usage'));
  assert.equal(u.tenant_id, tenant2);
  assert.ok(u.usage.ai);
  assert.equal(u.limits.max_cost_per_month, 0.01);
  assert.equal(u.used.ai_cost, 0.05);
  assert.ok(u.billing && u.billing.cycle);

  const users = await json(await req('/admin/tenants/' + tenant2 + '/users'));
  assert.ok(users.users.some(x => x.id === t2UserId && x.username === 'q_user'));
});

test('S9 权限：非超管访问运营接口 403', async () => {
  assert.equal((await req('/admin/overview', 'GET', undefined, adminToken)).status, 403);
  assert.equal((await req('/admin/tenants', 'GET', undefined, adminToken)).status, 403);
  assert.equal((await req('/admin/tenants/' + tenant2 + '/usage', 'GET', undefined, adminToken)).status, 403);
});

test('S9 成本配额：当月成本超限时拒绝 AI 调用', async () => {
  const r = await req('/agents/a1/run', 'POST', { input: '测试' }, t2Token);
  assert.equal(r.status, 429);
  const body = await r.json();
  assert.match(body.error, /成本额度/);
});
