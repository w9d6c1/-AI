// ===== 阶段 9 · 出账与发票回归（出账/开票/收款/汇总/导出/权限）=====
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecom-stage9bill-'));
Object.assign(process.env, {
  DATA_DIR: path.join(root, 'data'), DB_PATH: path.join(root, 'data/ecom-ai.db'), UPLOAD_DIR: path.join(root, 'uploads'),
  JWT_SECRET: crypto.randomBytes(32).toString('hex'), RPA_CALLBACK_TOKEN: 'stage9bill-token',
  DB_DRIVER: 'sqlite', RPA_MOCK_MODE: 'true', EXECUTOR_DRIVER: 'manual', AUTO_EXECUTE_ENABLED: 'false',
  QUEUE_ENABLED: 'false', STORAGE_DRIVER: 'local', ENABLE_SCHEDULER: 'false',
  SEED_DEFAULT_USERS: 'false', SEED_DEMO_DATA: 'false', ALLOW_REGISTRATION: 'false',
  AI_API_KEY: '', AI_IMAGE_API_KEY: '', AI_PROVIDERS: '',
  BILLING_TAX_RATE: '0', BILLING_USAGE_MARKUP: '1', BILLING_DUE_DAYS: '15'
});

const app = require('../server/index');
const { defaultAdapter } = require('../server/repositories');
const { runWithTenant } = require('../server/repositories/tenant-context');
const { signToken } = require('../server/middleware');
const { db } = require('../server/db');

let server, base, superToken, adminToken, tenant2, tenant2AdminId;

before(async () => {
  await runWithTenant(1, async () => {
    const superId = (await defaultAdapter.run('INSERT INTO users (tenant_id,username,password_hash,role) VALUES (?,?,?,?)', [1, 'root', bcrypt.hashSync('x', 4), 'superadmin'])).lastInsertRowid;
    const adminId = (await defaultAdapter.run('INSERT INTO users (tenant_id,username,password_hash,role) VALUES (?,?,?,?)', [1, 'admin', bcrypt.hashSync('x', 4), 'admin'])).lastInsertRowid;
    superToken = await signToken({ id: superId, role: 'superadmin', session_version: 0 });
    adminToken = await signToken({ id: adminId, tenant_id: 1, session_version: 0 });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;

  const created = await (await req('/admin/tenants', 'POST', {
    name: '计费租户', slug: 'bill-tenant', plan: 'pro',
    max_shops: 10, max_ai_calls_per_month: 10000, max_cost_per_month: 0,
    price_per_month: 1000, tax_rate: 0.06, billing_cycle: 'monthly',
    contact_name: '李四', contact_email: 'billing@example.com'
  }, superToken)).json();
  tenant2 = created.tenant.id;

  const u = await (await req('/admin/tenants/' + tenant2 + '/users', 'POST', { username: 'bill_user', password: 'Passw0rd!2345', role: 'admin' }, superToken)).json();
  tenant2AdminId = u.id;

  // 周期内 AI 用量：成本 200
  await runWithTenant(tenant2, async () => {
    await defaultAdapter.run(
      'INSERT INTO ai_usage (tenant_id,provider,capability,model,tokens_in,tokens_out,cost,created_at) VALUES (?,?,?,?,?,?,?,?)',
      [tenant2, 'local', 'chat', 'm1', 1000, 2000, 200, '2026-08-15 10:00:00']
    );
  });
});

after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  try { db.close(); } catch (_) { /* ignore */ }
  const resolved = path.resolve(root);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('ecom-stage9bill-')) fs.rmSync(resolved, { recursive: true, force: true });
});

async function req(url, method = 'GET', body, tok = superToken) {
  const headers = { Authorization: 'Bearer ' + tok };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(base + '/api' + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function json(resp, status = 200) { assert.equal(resp.status, status, await resp.clone().text()); return resp.json(); }

let invoiceId;

test('S9-出账：订阅费 + 用量费 + 税，编号与明细正确', async () => {
  const run = await json(await req('/admin/billing/run', 'POST', {
    period_start: '2026-08-01', period_end: '2026-08-31', tenant_ids: [tenant2]
  }));
  assert.equal(run.created.length, 1);
  const inv = run.created[0];
  invoiceId = inv.id;
  assert.match(inv.invoice_no, /^INV-202608-\d{4}$/);
  assert.equal(Number(inv.subtotal), 1200);
  assert.equal(Number(inv.tax_rate), 0.06);
  assert.equal(Number(inv.tax_amount), 72);
  assert.equal(Number(inv.total), 1272);
  assert.equal(inv.status, 'draft');

  const detail = await json(await req('/admin/invoices/' + invoiceId));
  assert.equal(detail.items.length, 2);
  assert.equal(detail.items.find(i => i.item_type === 'subscription').amount, 1000);
  assert.equal(detail.items.find(i => i.item_type === 'ai_cost').amount, 200);
  assert.equal(detail.payments.length, 0);
});

test('S9-出账幂等：同周期重复出账跳过', async () => {
  const run = await json(await req('/admin/billing/run', 'POST', {
    period_start: '2026-08-01', period_end: '2026-08-31', tenant_ids: [tenant2]
  }));
  assert.equal(run.created.length, 0);
  assert.equal(run.skipped.length, 1);
  assert.equal(run.skipped[0].reason, 'exists');
});

test('S9-出账试算：dry_run 不落库', async () => {
  const run = await json(await req('/admin/billing/run', 'POST', {
    period_start: '2026-07-01', period_end: '2026-07-31', tenant_ids: [tenant2], dry_run: true
  }));
  assert.equal(run.dry_run, true);
  assert.equal(run.created.length, 1);
  assert.equal(run.created[0].subtotal, 1000); // 仅订阅费（7 月无用量）
  const list = await json(await req('/admin/invoices?tenant_id=' + tenant2));
  assert.ok(!list.invoices.some(i => i.period_start === '2026-07-01'));
});

test('S9-状态机：开票 → 部分收款 → 结清；作废限制', async () => {
  const issued = await json(await req('/admin/invoices/' + invoiceId + '/issue', 'POST'));
  assert.equal(issued.invoice.status, 'issued');
  assert.ok(issued.invoice.due_at);

  const partial = await json(await req('/admin/invoices/' + invoiceId + '/payments', 'POST', { amount: 600, method: 'bank', reference: 'TX001' }), 201);
  assert.equal(Number(partial.invoice.amount_paid), 600);
  assert.equal(partial.invoice.status, 'issued');

  const full = await json(await req('/admin/invoices/' + invoiceId + '/payments', 'POST', { amount: 672, method: 'wechat' }), 201);
  assert.equal(Number(full.invoice.amount_paid), 1272);
  assert.equal(full.invoice.status, 'paid');

  assert.equal((await req('/admin/invoices/' + invoiceId + '/void', 'POST')).status, 400);
});

test('S9-作废后可重开同周期', async () => {
  const run1 = await json(await req('/admin/billing/run', 'POST', { period_start: '2026-06-01', period_end: '2026-06-30', tenant_ids: [tenant2] }));
  const id1 = run1.created[0].id;
  await json(await req('/admin/invoices/' + id1 + '/void', 'POST'));
  const run2 = await json(await req('/admin/billing/run', 'POST', { period_start: '2026-06-01', period_end: '2026-06-30', tenant_ids: [tenant2] }));
  assert.equal(run2.created.length, 1);
  assert.notEqual(run2.created[0].id, id1);
});

test('S9-逾期刷新：issued 过期 → overdue', async () => {
  const run = await json(await req('/admin/billing/run', 'POST', { period_start: '2026-05-01', period_end: '2026-05-31', tenant_ids: [tenant2] }));
  const id = run.created[0].id;
  await json(await req('/admin/invoices/' + id + '/issue', 'POST'));
  await runWithTenant(tenant2, () => defaultAdapter.run("UPDATE invoices SET due_at='2020-01-01' WHERE id=? AND tenant_id=?", [id, tenant2]));
  const res = await json(await req('/admin/billing/refresh-overdue', 'POST'));
  assert.ok(res.updated >= 1);
  const detail = await json(await req('/admin/invoices/' + id));
  assert.equal(detail.invoice.status, 'overdue');
});

test('S9-汇总：应收/已收/未收/逾期', async () => {
  const s = await json(await req('/admin/billing/summary?month=2026-08'));
  assert.ok(s.billed >= 1272);
  assert.ok(s.collected >= 1272);
  assert.equal(s.outstanding, Math.round((s.billed - s.collected) * 100) / 100);
  assert.ok(s.by_status && typeof s.by_status === 'object');
});

test('S9-导出：CSV 带 BOM 与发票号；Excel 类型正确', async () => {
  const csvResp = await req('/admin/invoices/' + invoiceId + '/export?format=csv');
  assert.equal(csvResp.status, 200);
  assert.match(csvResp.headers.get('content-type'), /text\/csv/);
  const buf = Buffer.from(await csvResp.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
  assert.ok(buf.toString('utf8').includes('INV-202608-'));

  const xlsResp = await req('/admin/invoices/' + invoiceId + '/export?format=xls');
  assert.equal(xlsResp.status, 200);
  assert.match(xlsResp.headers.get('content-type'), /vnd\.ms-excel/);
});

test('S9-权限：非超管访问出账接口 403', async () => {
  assert.equal((await req('/admin/invoices', 'GET', undefined, adminToken)).status, 403);
  assert.equal((await req('/admin/billing/run', 'POST', { period_start: '2026-08-01', period_end: '2026-08-31' }, adminToken)).status, 403);
  assert.equal((await req('/admin/billing/summary', 'GET', undefined, adminToken)).status, 403);
});
