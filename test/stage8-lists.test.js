// ===== 阶段 8 · 列表分页 + 看板账号下钻回归 =====
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecom-stage8lists-'));
Object.assign(process.env, {
  DATA_DIR: path.join(root, 'data'), DB_PATH: path.join(root, 'data/ecom-ai.db'), UPLOAD_DIR: path.join(root, 'uploads'),
  JWT_SECRET: crypto.randomBytes(32).toString('hex'), RPA_CALLBACK_TOKEN: 'stage8lists-token',
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
const { todayLocal } = require('../server/util');

let server, base, token, adminId, shopId;
const today = todayLocal();

before(async () => {
  await runWithTenant(1, async () => {
    adminId = (await defaultAdapter.run('INSERT INTO users (tenant_id,username,password_hash,role) VALUES (?,?,?,?)', [1, 'admin', bcrypt.hashSync('x', 4), 'admin'])).lastInsertRowid;
    shopId = (await defaultAdapter.run("INSERT INTO shops (tenant_id,shop_name,qianniu_account,platform,status,daily_adjust_limit) VALUES (?,?,?,?,?,?)", [1, '分页店', 'qn_s8l', 'taobao', 'active', 50])).lastInsertRowid;

    for (const p of ['p1', 'p2', 'p3']) {
      await defaultAdapter.run('INSERT INTO products (tenant_id,shop_id,product_id,title,price,platform) VALUES (?,?,?,?,?,?)', [1, shopId, p, '商品' + p, 10, 'taobao']);
    }
    for (const a of ['create', 'update', 'delete']) {
      await defaultAdapter.run('INSERT INTO audit_logs (tenant_id,user_id,action,target_type,target_id) VALUES (?,?,?,?,?)', [1, adminId, a, 'shop', String(shopId)]);
    }
    for (const n of ['r1', 'r2', 'r3']) {
      await defaultAdapter.run("INSERT INTO report_records (tenant_id,name,report_type,status,created_by) VALUES (?,?,?,?,?)", [1, n, 'daily_summary', 'completed', adminId]);
    }
    for (let i = 0; i < 3; i++) {
      await defaultAdapter.run('INSERT INTO agent_runs (tenant_id,user_id,agent_id,agent_name,input,result,result_parsed,source) VALUES (?,?,?,?,?,?,?,?)', [1, adminId, 'a1', '蓝海探测智能体', 'q' + i, 'raw', '{"ok":true}', 'rule']);
    }
    await defaultAdapter.run("INSERT INTO ad_campaigns (tenant_id,shop_id,campaign_id,campaign_name,campaign_type,report_date,cost,impressions,clicks,pay_amount,roi,status,platform,account_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [1, shopId, 'c1', '计划1', 'standard', today, 100, 1000, 50, 400, 4, 'running', 'taobao', 'acct_1']);
    await defaultAdapter.run("INSERT INTO ad_campaigns (tenant_id,shop_id,campaign_id,campaign_name,campaign_type,report_date,cost,impressions,clicks,pay_amount,roi,status,platform,account_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [1, shopId, 'c2', '计划2', 'standard', today, 200, 2000, 80, 300, 1.5, 'running', 'taobao', 'acct_1']);

    token = await signToken({ id: adminId, tenant_id: 1, session_version: 0 });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});

after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  try { db.close(); } catch (_) { /* ignore */ }
  const resolved = path.resolve(root);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('ecom-stage8lists-')) fs.rmSync(resolved, { recursive: true, force: true });
});

async function req(url) {
  return fetch(base + '/api' + url, { headers: { Authorization: 'Bearer ' + token } });
}
async function json(resp, status = 200) { assert.equal(resp.status, status, await resp.clone().text()); return resp.json(); }

test('S8-列表分页：商品 limit/offset 生效', async () => {
  const p1 = await json(await req('/stores/products?limit=1&offset=0'));
  const p2 = await json(await req('/stores/products?limit=1&offset=1'));
  assert.equal(p1.products.length, 1);
  assert.equal(p2.products.length, 1);
  assert.equal(p2.offset, 1);
  assert.notEqual(p1.products[0].id, p2.products[0].id);
});

test('S8-列表分页：审计日志 limit/offset 生效', async () => {
  const p1 = await json(await req('/stores/audit-logs?limit=2&offset=0'));
  const p2 = await json(await req('/stores/audit-logs?limit=2&offset=2'));
  assert.equal(p1.logs.length, 2);
  assert.equal(p2.logs.length, 1);
  assert.equal(p2.offset, 2);
});

test('S8-列表分页：报表 limit/offset 生效', async () => {
  const p1 = await json(await req('/reports?limit=2&offset=0'));
  const p2 = await json(await req('/reports?limit=2&offset=2'));
  assert.equal(p1.reports.length, 2);
  assert.equal(p2.reports.length, 1);
  assert.equal(p2.reports[0].name, 'r1');
});

test('S8-列表分页：智能体运行历史 limit/offset 生效', async () => {
  const p1 = await json(await req('/agent-runs?limit=2&offset=0'));
  const p2 = await json(await req('/agent-runs?limit=2&offset=2'));
  assert.equal(p1.runs.length, 2);
  assert.equal(p2.runs.length, 1);
});

test('S8-看板账号下钻：按 account_id 返回计划明细', async () => {
  const drill = await json(await req('/dashboard/accounts/acct_1/campaigns?range=7d'));
  assert.equal(drill.account_id, 'acct_1');
  assert.equal(drill.campaigns.length, 2);
  const c = drill.campaigns.find(x => x.campaign_id === 'c1');
  assert.equal(c.cost, 100);
  assert.equal(c.pay, 400);
  assert.equal(c.roi, 4);
  assert.equal(c.days, 1);

  const none = await json(await req('/dashboard/accounts/nope/campaigns?range=7d'));
  assert.equal(none.campaigns.length, 0);
});
