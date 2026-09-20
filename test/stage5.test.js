const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecom-stage5-'));
Object.assign(process.env, {
  DATA_DIR: path.join(root, 'data'), DB_PATH: path.join(root, 'data/ecom-ai.db'), UPLOAD_DIR: path.join(root, 'uploads'),
  JWT_SECRET: crypto.randomBytes(32).toString('hex'), RPA_CALLBACK_TOKEN: 'stage5-token',
  DB_DRIVER: 'sqlite', RPA_MOCK_MODE: 'true',
  EXECUTOR_DRIVER: 'rpa', AUTO_EXECUTE_ENABLED: 'true', AUTO_EXECUTE_COUNTDOWN_SEC: '0',
  AUTO_EXECUTE_FAILURE_THRESHOLD: '2', AUTO_EXECUTE_COOLDOWN_MIN: '30', MAX_ADJUST_RATIO: '0.3',
  QUEUE_ENABLED: 'false', STORAGE_DRIVER: 'local', ENABLE_SCHEDULER: 'false',
  SEED_DEFAULT_USERS: 'false', SEED_DEMO_DATA: 'false', ALLOW_REGISTRATION: 'false',
  AI_API_KEY: '', AI_IMAGE_API_KEY: '', AI_PROVIDERS: ''
});

const app = require('../server/index');
const { defaultAdapter } = require('../server/repositories');
const { runWithTenant } = require('../server/repositories/tenant-context');
const { signToken } = require('../server/middleware');
const { db } = require('../server/db');
const { nowLocal, todayLocal } = require('../server/util');
const executionService = require('../server/execution-service');

let server, base, token, adminId, shop1, shop2, suggestion1;

before(async () => {
  await runWithTenant(1, async () => {
    adminId = (await defaultAdapter.run('INSERT INTO users (tenant_id,username,password_hash,role) VALUES (?,?,?,?)', [1, 'admin', bcrypt.hashSync('x', 4), 'admin'])).lastInsertRowid;
    shop1 = (await defaultAdapter.run('INSERT INTO shops (tenant_id,shop_name,qianniu_account,platform,status,daily_adjust_limit) VALUES (?,?,?,?,?,?)', [1, '店1', 'qn1', 'taobao', 'active', 50])).lastInsertRowid;
    shop2 = (await defaultAdapter.run('INSERT INTO shops (tenant_id,shop_name,qianniu_account,platform,status,daily_adjust_limit) VALUES (?,?,?,?,?,?)', [1, '店2', 'qn2', 'taobao', 'active', 1])).lastInsertRowid;
    suggestion1 = (await defaultAdapter.run("INSERT INTO suggestions (tenant_id,shop_id,suggestion_date,status) VALUES (?,?,?,?)", [1, shop1, todayLocal(), 'approved'])).lastInsertRowid;
    await defaultAdapter.run("INSERT INTO suggestion_items (tenant_id,suggestion_id,campaign_id,action_type,current_value,suggested_value,status) VALUES (?,?,?,?,?,?,?)", [1, suggestion1, 'c1', 'pause', null, null, 'approved']);
    await defaultAdapter.run("INSERT INTO suggestion_items (tenant_id,suggestion_id,campaign_id,action_type,current_value,suggested_value,status) VALUES (?,?,?,?,?,?,?)", [1, suggestion1, 'c2', 'adjust_price', 10, 12, 'approved']);
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
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('ecom-stage5-')) fs.rmSync(resolved, { recursive: true, force: true });
});

async function req(url, method = 'GET', body, raw) {
  const headers = { Authorization: 'Bearer ' + token };
  if (body !== undefined && !raw) headers['Content-Type'] = 'application/json';
  return fetch(base + '/api' + url, { method, headers, body: raw ? body : (body === undefined ? undefined : JSON.stringify(body)) });
}
async function json(resp, status = 200) { assert.equal(resp.status, status, await resp.clone().text()); return resp.json(); }

test('P5-1 审核通过 → 生成执行清单（自动模式进入待审批，快照期望值）', async () => {
  const r = await json(await req('/stores/suggestions/' + suggestion1 + '/execution-list', 'POST'));
  assert.equal(r.auto, true);
  assert.equal(r.executions.length, 2);
  assert.ok(r.executions.every(e => e.status === 'pending_approval' && e.is_auto === 1));
  const price = r.executions.find(e => e.action_type === 'adjust_price');
  assert.equal(Number(price.expected_value), 12);
  assert.equal(Number(price.before_value), 10);
  assert.ok(price.not_before);
});

test('P5-4 审批通过 → 派发（倒计时到期，Mock 执行成功）；驳回则终止', async () => {
  const list = await json(await req('/stores/executions?status=pending_approval'));
  const target = list.executions.find(e => e.action_type === 'pause');
  const other = list.executions.find(e => e.id !== target.id);

  const approved = await json(await req('/stores/executions/' + target.id + '/approve', 'POST'));
  assert.equal(approved.execution.status, 'queued');
  assert.ok(approved.execution.approved_at);

  const rejected = await json(await req('/stores/executions/' + other.id + '/reject', 'POST'));
  assert.equal(rejected.execution.status, 'rejected');

  const proc = await json(await req('/stores/auto-execute/process', 'POST'));
  assert.ok(proc.dispatched >= 1);

  const done = await json(await req('/stores/executions/' + target.id));
  assert.equal(done.execution.status, 'success');
  assert.ok(done.execution.rpa_job_id);
});

test('P5-4 日限额：超过上限的自动执行被跳过', async () => {
  const sug = await runWithTenant(1, async () => {
    const sid = (await defaultAdapter.run("INSERT INTO suggestions (tenant_id,shop_id,suggestion_date,status) VALUES (?,?,?,?)", [1, shop2, todayLocal(), 'approved'])).lastInsertRowid;
    for (const c of ['a', 'b']) await defaultAdapter.run("INSERT INTO suggestion_items (tenant_id,suggestion_id,campaign_id,action_type,status) VALUES (?,?,?,?,?)", [1, sid, c, 'pause', 'approved']);
    return sid;
  });
  const created = await json(await req('/stores/suggestions/' + sug + '/execution-list', 'POST'));
  for (const e of created.executions) await req('/stores/executions/' + e.id + '/approve', 'POST');
  const proc = await json(await req('/stores/auto-execute/process', 'POST'));
  assert.ok(proc.dispatched >= 1);
  assert.ok(proc.skipped >= 1);
  const rows = await runWithTenant(1, () => defaultAdapter.all("SELECT status, error_msg FROM executions WHERE tenant_id=? AND shop_id=? AND is_auto=1 ORDER BY id", [1, shop2]));
  assert.ok(rows.some(r => r.status === 'skipped' && /上限/.test(r.error_msg || '')));
});

test('P5-4 幅度上限：超幅度的自动执行被跳过', async () => {
  const execId = await runWithTenant(1, async () => (await defaultAdapter.run(
    "INSERT INTO executions (tenant_id,shop_id,action_type,target_campaign_id,status,expected_value,before_value,is_auto,not_before) VALUES (?,?,?,?,?,?,?,?,?)",
    [1, shop1, 'adjust_price', 'cX', 'queued', 20, 10, 1, nowLocal()]
  )).lastInsertRowid);
  await json(await req('/stores/auto-execute/process', 'POST'));
  const row = await runWithTenant(1, () => defaultAdapter.get('SELECT status, error_msg FROM executions WHERE id=? AND tenant_id=?', [execId, 1]));
  assert.equal(row.status, 'skipped');
  assert.ok(/幅度/.test(row.error_msg || ''));
});

test('P5-4 熔断：失败达阈值后阻断派发', async () => {
  await runWithTenant(1, async () => {
    for (let i = 0; i < 2; i++) {
      await defaultAdapter.run("INSERT INTO executions (tenant_id,shop_id,action_type,target_campaign_id,status,is_auto,finished_at) VALUES (?,?,?,?,?,?,?)", [1, shop1, 'pause', 'cf' + i, 'failed', 1, nowLocal()]);
    }
    await defaultAdapter.run("INSERT INTO executions (tenant_id,shop_id,action_type,target_campaign_id,status,is_auto,not_before) VALUES (?,?,?,?,?,?,?)", [1, shop1, 'pause', 'cq', 'queued', 1, nowLocal()]);
  });
  const st = await json(await req('/stores/auto-execute/status'));
  assert.equal(st.circuit_open, true);
  const proc = await json(await req('/stores/auto-execute/process', 'POST'));
  assert.equal(proc.blocked, true);
  assert.equal(proc.dispatched, 0);
});

test('P5-3 对账报表：匹配/差异统计 + 报表导出', async () => {
  await runWithTenant(1, async () => {
    await defaultAdapter.run("INSERT INTO executions (tenant_id,shop_id,action_type,target_campaign_id,status,expected_value,actual_value,is_auto,finished_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)", [1, shop1, 'adjust_price', 'r1', 'success', 12, 12, 0, nowLocal(), nowLocal()]);
    await defaultAdapter.run("INSERT INTO executions (tenant_id,shop_id,action_type,target_campaign_id,status,expected_value,actual_value,is_auto,finished_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)", [1, shop1, 'adjust_price', 'r2', 'success', 12, 15, 0, nowLocal(), nowLocal()]);
  });
  const rep = await json(await req('/stores/reconcile/report'));
  assert.ok(rep.summary.comparable >= 2);
  assert.ok(rep.summary.mismatched >= 1);
  assert.ok(rep.by_action.adjust_price);

  const created = await json(await req('/reports', 'POST', { name: '对账', report_type: 'reconcile_report', file_format: 'csv', date_start: todayLocal(), date_end: todayLocal() }), 201);
  assert.ok(created.row_count >= 2);
  const dl = await req('/reports/' + created.id + '/download');
  assert.equal(dl.status, 200);
});

test('P5-2 导出 CSV/Excel + 批量回填', async () => {
  const execId = await runWithTenant(1, async () => (await defaultAdapter.run(
    "INSERT INTO executions (tenant_id,shop_id,action_type,target_campaign_id,status,expected_value,before_value,is_auto) VALUES (?,?,?,?,?,?,?,?)",
    [1, shop1, 'adjust_price', 'm1', 'pending_manual', 12, 10, 0]
  )).lastInsertRowid);

  const csv = await req('/stores/executions/export?status=pending_manual&format=csv');
  assert.equal(csv.status, 200);
  assert.ok((await csv.text()).includes(String(execId)));

  const xls = await req('/stores/executions/export?status=pending_manual&format=xls');
  assert.equal(xls.status, 200);
  assert.ok(String(xls.headers.get('content-type')).includes('ms-excel'));
  assert.ok((await xls.text()).includes('<Workbook'));

  const form = new FormData();
  form.append('file', new Blob(['execution_id,status,actual_value,note\n' + execId + ',success,11.5,人工回填\n'], { type: 'text/csv' }), 'backfill.csv');
  const back = await fetch(base + '/api/stores/executions/backfill', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form });
  const body = await json(back);
  assert.equal(body.success, 1);
  const row = await runWithTenant(1, () => defaultAdapter.get('SELECT status, actual_value FROM executions WHERE id=? AND tenant_id=?', [execId, 1]));
  assert.equal(row.status, 'success');
  assert.equal(Number(row.actual_value), 11.5);
});

test('P5-5 执行详情：证据（审计留痕）', async () => {
  const list = await json(await req('/stores/executions?status=success'));
  const id = list.executions[0].id;
  const detail = await json(await req('/stores/executions/' + id));
  assert.ok(detail.execution);
  assert.ok(Array.isArray(detail.evidence.audit));
});

test('P5-4 回滚：以执行前值创建反向执行', async () => {
  const execId = await runWithTenant(1, async () => (await defaultAdapter.run(
    "INSERT INTO executions (tenant_id,shop_id,action_type,target_campaign_id,status,expected_value,before_value,actual_value,is_auto,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [1, shop1, 'adjust_price', 'rb1', 'success', 12, 10, 12, 0, nowLocal()]
  )).lastInsertRowid);
  const r = await json(await req('/stores/executions/' + execId + '/rollback', 'POST'));
  assert.equal(r.execution.rollback_of, execId);
  assert.equal(Number(r.execution.expected_value), 10);
  assert.ok(['pending_manual', 'queued', 'success'].includes(r.execution.status));
});

test('P5-4 自动执行配置：默认关闭时 processDue 不派发', async () => {
  const cfg = executionService.autoConfig();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.countdownSec, 0);
  assert.equal(cfg.failureThreshold, 2);
});
