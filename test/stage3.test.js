const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecom-stage3-'));
Object.assign(process.env, {
  DATA_DIR: path.join(root, 'data'), DB_PATH: path.join(root, 'data/ecom-ai.db'), UPLOAD_DIR: path.join(root, 'uploads'),
  JWT_SECRET: crypto.randomBytes(32).toString('hex'), RPA_CALLBACK_TOKEN: 'stage3-token',
  DB_DRIVER: 'sqlite', RPA_MOCK_MODE: 'true', EXECUTOR_DRIVER: 'manual', AUTO_EXECUTE_ENABLED: 'false',
  QUEUE_ENABLED: 'false', STORAGE_DRIVER: 'local', ENABLE_SCHEDULER: 'false',
  SEED_DEFAULT_USERS: 'false', SEED_DEMO_DATA: 'false', ALLOW_REGISTRATION: 'false',
  AI_API_KEY: '', AI_IMAGE_API_KEY: '', AI_PROVIDERS: '', COLLECT_MAX_RETRIES: '1'
});

const app = require('../server/index');
const { defaultAdapter } = require('../server/repositories');
const { runWithTenant } = require('../server/repositories/tenant-context');
const { signToken } = require('../server/middleware');
const { db } = require('../server/db');
const csvCollector = require('../server/integrations/collectors/csv');
const collectionState = require('../server/collection-state');
const { triggerCollection } = require('../server/rpa');

let server, base, token, adminId, shopA, shopB;

before(async () => {
  await runWithTenant(1, async () => {
    adminId = (await defaultAdapter.run('INSERT INTO users (tenant_id,username,password_hash,role) VALUES (?,?,?,?)', [1, 'admin', bcrypt.hashSync('x', 4), 'admin'])).lastInsertRowid;
    shopA = (await defaultAdapter.run('INSERT INTO shops (tenant_id,shop_name,qianniu_account,platform) VALUES (?,?,?,?)', [1, '淘宝店', 'qn_a', 'taobao'])).lastInsertRowid;
    shopB = (await defaultAdapter.run('INSERT INTO shops (tenant_id,shop_name,qianniu_account,platform) VALUES (?,?,?,?)', [1, '抖音店', 'qn_b', 'douyin'])).lastInsertRowid;
    await defaultAdapter.run('UPDATE shops SET daily_adjust_limit=? WHERE tenant_id=?', [50, 1]);
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
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('ecom-stage3-')) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

async function req(url, method = 'GET', body) {
  const headers = { Authorization: 'Bearer ' + token };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(base + '/api' + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function json(resp, status = 200) {
  assert.equal(resp.status, status, await resp.clone().text());
  return resp.json();
}
async function importCsv(text, type = 'auto') {
  const form = new FormData();
  form.append('file', new Blob([text], { type: 'text/csv' }), 'data.csv');
  const resp = await fetch(base + `/api/stores/import/csv?type=${type}`, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form });
  return { status: resp.status, body: await resp.json() };
}

test('采集器：6 种导入类型与模板', () => {
  const types = csvCollector.types().map(t => t.value);
  assert.deepEqual(types, ['daily_report', 'ad_campaign', 'product', 'product_daily', 'orders_daily', 'refunds_daily']);
  for (const t of types) assert.ok(csvCollector.template(t).length > 10);
});

test('P3-3：质量告警不阻断入库，raw_json 留痕', async () => {
  const text = '千牛账号,日期,访客数,支付金额,转化率\nqn_a,2026-09-20,-5,1000,3\n';
  const r = await importCsv(text);
  assert.equal(r.status, 200);
  assert.equal(r.body.report.status, 'success');
  assert.ok(r.body.report.warnings.length >= 2, JSON.stringify(r.body.report.warnings));
  await runWithTenant(1, async () => {
    const row = await defaultAdapter.get('SELECT * FROM daily_reports WHERE tenant_id=? AND shop_id=? AND report_date=?', [1, shopA, '2026-09-20']);
    assert.ok(row.raw_json);
    assert.equal(JSON.parse(row.raw_json).conversion_rate, '3');
  });
});

test('P3-5：重复导入去重（updated 计数、行数不增）', async () => {
  const text = 'shop_qianniu_account,report_date,visitors,pay_amount\nqn_a,2026-09-19,100,900\n';
  const first = await importCsv(text);
  assert.equal(first.body.report.inserted, 1);
  assert.equal(first.body.report.updated, 0);
  const second = await importCsv(text);
  assert.equal(second.body.report.inserted, 0);
  assert.equal(second.body.report.updated, 1);
  await runWithTenant(1, async () => {
    const rows = await defaultAdapter.all('SELECT id FROM daily_reports WHERE tenant_id=? AND shop_id=? AND report_date=?', [1, shopA, '2026-09-19']);
    assert.equal(rows.length, 1);
  });
});

test('P3-1：商品/商品日报/订单日报/退款日报导入与查询', async () => {
  await importCsv('千牛账号,商品ID,商品标题,类目,价格,状态,平台\nqn_a,p1,商品A,女装,99,on_sale,taobao\n');
  await importCsv('千牛账号,商品ID,日期,访客数,支付金额,退款金额,平台\nqn_a,p1,2026-09-20,800,2000,50,taobao\n');
  await importCsv('千牛账号,日期,订单数,支付订单数,支付金额,退款金额,新买家数,老买家数,平台\nqn_b,2026-09-20,60,45,3600,100,20,16,douyin\n');
  await importCsv('千牛账号,日期,退款笔数,退款金额,退款率,主要退款原因,平台\nqn_b,2026-09-20,3,150,0.02,尺码不符,douyin\n');

  await runWithTenant(1, async () => {
    const p = await defaultAdapter.get('SELECT * FROM products WHERE tenant_id=? AND shop_id=? AND product_id=?', [1, shopA, 'p1']);
    assert.equal(p.title, '商品A');
    assert.equal(p.platform, 'taobao');
    const pd = await defaultAdapter.get('SELECT * FROM product_daily WHERE tenant_id=? AND shop_id=? AND product_id=? AND report_date=?', [1, shopA, 'p1', '2026-09-20']);
    assert.equal(Number(pd.pay_amount), 2000);
    const od = await defaultAdapter.get('SELECT * FROM orders_daily WHERE tenant_id=? AND shop_id=? AND report_date=?', [1, shopB, '2026-09-20']);
    assert.equal(Number(od.order_count), 60);
    const rd = await defaultAdapter.get('SELECT * FROM refunds_daily WHERE tenant_id=? AND shop_id=? AND report_date=?', [1, shopB, '2026-09-20']);
    assert.equal(rd.reason_top, '尺码不符');
  });

  const products = await json(await req('/stores/products'));
  assert.ok(products.products.some(p => p.product_id === 'p1'));
  const orders = await json(await req('/stores/orders?platform=douyin'));
  assert.equal(orders.rows.length, 1);
  const refunds = await json(await req('/stores/refunds?platform=douyin'));
  assert.equal(refunds.rows.length, 1);
  const pdaily = await json(await req('/stores/product-daily?shop_id=' + shopA));
  assert.equal(pdaily.rows.length, 1);
});

test('P3-4：多平台字段与筛选（店铺/看板）', async () => {
  const shops = await json(await req('/shops?platform=douyin'));
  assert.equal(shops.shops.length, 1);
  assert.equal(shops.shops[0].shop_name, '抖音店');

  const dash = await json(await req('/stores/dashboard?platform=douyin'));
  assert.equal(dash.shops.length, 1);
  assert.equal(dash.shops[0].shop_id, shopB);

  const types = await json(await req('/stores/import/types'));
  assert.equal(types.types.length, 6);
});

test('P3-2：采集状态机迁移与重试上限', async () => {
  assert.equal(collectionState.canTransition('queued', 'running'), true);
  assert.equal(collectionState.canTransition('success', 'running'), false);
  await runWithTenant(1, async () => {
    const taskId = (await defaultAdapter.run("INSERT INTO collection_tasks (tenant_id,shop_id,task_date,status) VALUES (?,?,?,?)", [1, shopA, '2026-09-18', 'running'])).lastInsertRowid;
    await collectionState.markRunning(taskId, 'job-1');
    const running = await defaultAdapter.get('SELECT * FROM collection_tasks WHERE id=? AND tenant_id=?', [taskId, 1]);
    assert.equal(running.status, 'running');
    assert.equal(running.rpa_job_id, 'job-1');

    const f1 = await collectionState.registerFailure(taskId, 'timeout');
    assert.equal(f1.retried, true);
    const retry = await defaultAdapter.get('SELECT * FROM collection_tasks WHERE id=? AND tenant_id=?', [taskId, 1]);
    assert.equal(retry.status, 'queued');
    assert.equal(retry.retry_count, 1);

    const f2 = await collectionState.registerFailure(taskId, 'timeout-2');
    assert.equal(f2.retried, false);
    const failed = await defaultAdapter.get('SELECT * FROM collection_tasks WHERE id=? AND tenant_id=?', [taskId, 1]);
    assert.equal(failed.status, 'failed');
  });
});

test('P3-4：Mock 采集写入 platform 与 raw_json', async () => {
  await runWithTenant(1, async () => {
    await defaultAdapter.run('INSERT INTO collection_tasks (tenant_id,shop_id,task_date,status) VALUES (?,?,?,?)', [1, shopB, '2026-09-15', 'queued']);
    await triggerCollection(shopB, 'qn_b', '2026-09-15');
    const c = await defaultAdapter.get('SELECT platform, raw_json FROM ad_campaigns WHERE tenant_id=? AND shop_id=? AND report_date=? LIMIT 1', [1, shopB, '2026-09-15']);
    assert.equal(c.platform, 'douyin');
    assert.ok(c.raw_json && JSON.parse(c.raw_json).campaign_id);
    const dr = await defaultAdapter.get('SELECT raw_json FROM daily_reports WHERE tenant_id=? AND shop_id=? AND report_date=?', [1, shopB, '2026-09-15']);
    assert.ok(dr.raw_json);
  });
});

test('P3-2：回调写入订单日报/退款日报', async () => {
  const post = (event, data, job, date) => fetch(base + '/api/rpa/callback/collect', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-callback-token': 'stage3-token' },
    body: JSON.stringify({ event, job_id: job, shop_id: shopA, report_date: date, status: 'success', data })
  });
  await runWithTenant(1, async () => {
    await defaultAdapter.run('INSERT INTO collection_tasks (tenant_id,shop_id,task_date,status,rpa_job_id) VALUES (?,?,?,?,?)', [1, shopA, '2026-09-14', 'running', 'job-od']);
    await defaultAdapter.run('INSERT INTO collection_tasks (tenant_id,shop_id,task_date,status,rpa_job_id) VALUES (?,?,?,?,?)', [1, shopA, '2026-09-13', 'running', 'job-rd']);
  });
  assert.equal((await post('collect_orders_daily', { order_count: 10, pay_amount: 100 }, 'job-od', '2026-09-14')).status, 200);
  assert.equal((await post('collect_refunds_daily', { refund_count: 2, refund_amount: 30, reason_top: '质量问题' }, 'job-rd', '2026-09-13')).status, 200);
  await runWithTenant(1, async () => {
    const od = await defaultAdapter.get('SELECT * FROM orders_daily WHERE tenant_id=? AND shop_id=? AND report_date=?', [1, shopA, '2026-09-14']);
    assert.equal(Number(od.order_count), 10);
    const rd = await defaultAdapter.get('SELECT * FROM refunds_daily WHERE tenant_id=? AND shop_id=? AND report_date=?', [1, shopA, '2026-09-13']);
    assert.equal(rd.reason_top, '质量问题');
    assert.ok(rd.raw_json);
  });
});

test('P3-2：回调写入商品日报并标记任务成功（幂等）', async () => {
  let taskId;
  await runWithTenant(1, async () => {
    taskId = (await defaultAdapter.run("INSERT INTO collection_tasks (tenant_id,shop_id,task_date,status,rpa_job_id) VALUES (?,?,?,?,?)", [1, shopA, '2026-09-16', 'running', 'job-prod'])).lastInsertRowid;
  });
  const body = {
    event: 'collect_product_daily', job_id: 'job-prod', shop_id: shopA, report_date: '2026-09-16', status: 'success',
    data: [{ product_id: 'p9', visitors: 10, pay_amount: 88, refund_amount: 0, refund_count: 0 }]
  };
  const send = () => fetch(base + '/api/rpa/callback/collect', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-callback-token': 'stage3-token' }, body: JSON.stringify(body)
  });
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 200); // 重复回调幂等
  await runWithTenant(1, async () => {
    const pd = await defaultAdapter.get('SELECT * FROM product_daily WHERE tenant_id=? AND shop_id=? AND product_id=? AND report_date=?', [1, shopA, 'p9', '2026-09-16']);
    assert.equal(Number(pd.pay_amount), 88);
    const rows = await defaultAdapter.all('SELECT id FROM product_daily WHERE tenant_id=? AND shop_id=? AND product_id=? AND report_date=?', [1, shopA, 'p9', '2026-09-16']);
    assert.equal(rows.length, 1);
    const task = await defaultAdapter.get('SELECT status FROM collection_tasks WHERE id=? AND tenant_id=?', [taskId, 1]);
    assert.equal(task.status, 'success');
  });
});
