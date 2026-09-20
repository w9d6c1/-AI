// ===== 多租户隔离与超管/代登录回归 =====
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecom-tenant-'));
Object.assign(process.env, {
  DATA_DIR: path.join(root, 'data'), DB_PATH: path.join(root, 'data/ecom-ai.db'), UPLOAD_DIR: path.join(root, 'uploads'),
  JWT_SECRET: crypto.randomBytes(32).toString('hex'), RPA_CALLBACK_TOKEN: crypto.randomBytes(32).toString('hex'),
  AI_API_KEY: '', AI_IMAGE_API_KEY: '', ALLOW_REGISTRATION: 'false', ENABLE_SCHEDULER: 'false',
  SEED_DEFAULT_USERS: 'false', SEED_DEMO_DATA: 'false', RPA_MOCK_MODE: 'true', TRUST_PROXY: '', CORS_ORIGIN: '',
  DB_DRIVER: 'sqlite'
});

const app = require('../server/index');
const { defaultAdapter } = require('../server/repositories');
const { runMigrations } = require('../server/migrations');
const { runWithTenant, runAsPlatform, TenantContextError, TenantScopeError } = require('../server/repositories/tenant-context');
const { signToken } = require('../server/middleware');

const db = require('../server/db').db;
const run = (sql, params) => defaultAdapter.run(sql, params);
const get = (sql, params) => defaultAdapter.get(sql, params);

const users = {};
let server, base, superToken, shop2Id;

before(async () => {
  await runMigrations(defaultAdapter);
  await runAsPlatform(async () => {
    await run("INSERT INTO tenants (id,name,slug,status) VALUES (2,'租户二','t2','active')");
    await run('INSERT INTO shops (id,tenant_id,shop_name,qianniu_account) VALUES (11,1,?,?)', ['租户一店', 's1']);
    shop2Id = (await run('INSERT INTO shops (tenant_id,shop_name,qianniu_account) VALUES (2,?,?)', ['租户二店', 's2'])).lastInsertRowid;
    await run('INSERT INTO daily_reports (tenant_id,shop_id,report_date,pay_amount) VALUES (1,11,?,?)', ['2026-09-19', 1000]);
    await run('INSERT INTO daily_reports (tenant_id,shop_id,report_date,pay_amount) VALUES (2,?,?,?)', [shop2Id, '2026-09-19', 9999]);
  });
  for (const [name, tenantId, role] of [['a1', 1, 'admin'], ['a2', 2, 'admin'], ['boss', 1, 'superadmin']]) {
    const r = await runWithTenant(tenantId, () => run('INSERT INTO users (tenant_id,username,password_hash,role) VALUES (?,?,?,?)', [tenantId, name, bcrypt.hashSync('TestPassword123!', 4), role]));
    users[name] = { id: r.lastInsertRowid, tenant_id: tenantId, role };
  }
  await runAsPlatform(async () => {
    users.a1.token = await signToken(users.a1);
    users.a2.token = await signToken(users.a2);
    superToken = await signToken(users.boss);
  });
});

after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  if (typeof defaultAdapter.close === 'function') await defaultAdapter.close();
  try { db.close(); } catch (_) { /* ignore */ }
  const resolved = path.resolve(root);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('ecom-tenant-')) fs.rmSync(resolved, { recursive: true, force: true });
});

async function req(url, token, method = 'GET', body) {
  const headers = token ? { Authorization: 'Bearer ' + token } : {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(base + '/api' + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

test('多租户隔离 / 超管 / 代登录', async t => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;

  await t.test('adapter 守卫：租户表缺上下文/缺 tenant_id 时 fail-closed', async () => {
    await assert.rejects(() => run('SELECT * FROM shops'), (e) => e instanceof TenantContextError || e.code === 'TENANT_CONTEXT_MISSING');
    await assert.rejects(() => runWithTenant(1, () => run('SELECT * FROM shops')), (e) => e instanceof TenantScopeError || e.code === 'TENANT_SCOPE_MISSING');
    const rows = await runWithTenant(1, () => defaultAdapter.all('SELECT id FROM shops WHERE tenant_id=?', [1]));
    assert.equal(rows.length, 1);
    const all = await runAsPlatform(() => defaultAdapter.all('SELECT id FROM shops'));
    assert.equal(all.length, 2);
  });

  await t.test('普通租户用户只能看到本租户店铺/报表', async () => {
    const shops = await (await req('/shops', users.a1.token)).json();
    assert.deepEqual(shops.shops.map(s => s.id), [11]);
    const a2shops = await (await req('/shops', users.a2.token)).json();
    assert.deepEqual(a2shops.shops.map(s => s.id), [shop2Id]);
    const stats = await (await req('/dashboard/stats', users.a1.token)).json();
    assert.ok(stats.metrics);
  });

  await t.test('普通用户访问超管接口被拒（403）', async () => {
    assert.equal((await req('/admin/tenants', users.a1.token)).status, 403);
    assert.equal((await req('/admin/tenants', null)).status, 401);
  });

  await t.test('超管可管理租户与查看跨租户视图', async () => {
    const list = await (await req('/admin/tenants', superToken)).json();
    assert.ok(list.tenants.length >= 2);
    const created = await req('/admin/tenants', superToken, 'POST', { name: '租户三' });
    assert.equal(created.status, 201);
    const ov = await (await req('/admin/tenants/2/overview', superToken)).json();
    assert.equal(ov.metrics.shops, 1);
    assert.equal(Number(ov.metrics.pay_7d), 9999);
    const logs = await (await req('/admin/tenants/2/audit-logs', superToken)).json();
    assert.ok(Array.isArray(logs.logs));
  });

  await t.test('代登录：短时只读 token，写操作被拒且留审计', async () => {
    const res = await req('/admin/users/' + users.a1.id + '/impersonate', superToken, 'POST');
    assert.equal(res.status, 200);
    const { token, tenant_id } = await res.json();
    assert.equal(tenant_id, 1);
    assert.equal((await req('/shops', token)).status, 200);
    assert.equal((await req('/shops', token, 'POST', { shop_name: 'x', qianniu_account: 'x' })).status, 403);
    const logs = await (await req('/admin/tenants/1/audit-logs', superToken)).json();
    assert.ok(logs.logs.some(l => l.action === 'impersonate'));
  });

  await t.test('守卫：逗号连接表也需 tenant_id', async () => {
    await assert.rejects(
      () => runWithTenant(1, () => run('SELECT * FROM tenants, shops')),
      (e) => e.code === 'TENANT_SCOPE_MISSING'
    );
    // 带 tenant_id 的逗号连接可放行
    const rows = await runWithTenant(1, () => defaultAdapter.all('SELECT shops.id FROM tenants, shops WHERE shops.tenant_id=? AND tenants.id=shops.tenant_id', [1]));
    assert.ok(rows.length >= 1);
  });

  await t.test('停用租户：既有 token 立即失效', async () => {
    await runAsPlatform(() => run("UPDATE tenants SET status='suspended' WHERE id=2"));
    assert.equal((await req('/shops', users.a2.token)).status, 401);
    await runAsPlatform(() => run("UPDATE tenants SET status='active' WHERE id=2"));
    assert.equal((await req('/shops', users.a2.token)).status, 200);
  });

  await t.test('配额：建店超上限被拒', async () => {
    await runAsPlatform(() => run('UPDATE tenants SET max_shops=1 WHERE id=1'));
    const res = await req('/shops', users.a1.token, 'POST', { shop_name: 'quota店', qianniu_account: 'q1' });
    assert.equal(res.status, 403);
    await runAsPlatform(() => run('UPDATE tenants SET max_shops=50 WHERE id=1'));
  });
});
