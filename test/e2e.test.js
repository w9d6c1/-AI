// ===== 端到端：CSV 导入 → 建议 → 审核 → 执行 → 对账 =====
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecom-e2e-'));
Object.assign(process.env, {
  DATA_DIR: path.join(root, 'data'), DB_PATH: path.join(root, 'data/ecom-ai.db'), UPLOAD_DIR: path.join(root, 'uploads'),
  JWT_SECRET: crypto.randomBytes(32).toString('hex'), RPA_CALLBACK_TOKEN: 'e2e-token',
  DB_DRIVER: 'sqlite', RPA_MOCK_MODE: 'true', EXECUTOR_DRIVER: 'manual', AUTO_EXECUTE_ENABLED: 'false',
  QUEUE_ENABLED: 'false', STORAGE_DRIVER: 'local', ENABLE_SCHEDULER: 'false',
  SEED_DEFAULT_USERS: 'false', SEED_DEMO_DATA: 'false', ALLOW_REGISTRATION: 'false',
  AI_API_KEY: '', AI_IMAGE_API_KEY: '', AI_PROVIDERS: '', SUGGEST_MIN_CONFIDENCE: '0.6', SUGGEST_CONCURRENCY: '1'
});

const app = require('../server/index');
const { defaultAdapter } = require('../server/repositories');
const { runWithTenant } = require('../server/repositories/tenant-context');
const { signToken } = require('../server/middleware');
const { db } = require('../server/db');
const { todayLocal } = require('../server/util');

let server, base, token, shopId;
const today = todayLocal();

before(async () => {
  await runWithTenant(1, async () => {
    const adminId = (await defaultAdapter.run('INSERT INTO users (tenant_id,username,password_hash,role) VALUES (?,?,?,?)', [1, 'admin', bcrypt.hashSync('x', 4), 'admin'])).lastInsertRowid;
    shopId = (await defaultAdapter.run("INSERT INTO shops (tenant_id,shop_name,qianniu_account,platform,status,daily_adjust_limit) VALUES (?,?,?,?,?,?)", [1, 'E2E店', 'qn_e2e', 'taobao', 'active', 50])).lastInsertRowid;
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
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('ecom-e2e-')) fs.rmSync(resolved, { recursive: true, force: true });
});

async function req(url, method = 'GET', body) {
  const headers = { Authorization: 'Bearer ' + token };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(base + '/api' + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function json(resp, status = 200) { assert.equal(resp.status, status, await resp.clone().text()); return resp.json(); }
async function importCsv(text) {
  const form = new FormData();
  form.append('file', new Blob([text], { type: 'text/csv' }), 'data.csv');
  const resp = await fetch(base + '/api/stores/import/csv?type=auto', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form });
  return { status: resp.status, body: await resp.json() };
}

const CAMPAIGN_CSV = [
  '千牛账号,日期,计划ID,计划名称,计划类型,花费,展现量,点击量,平均点击花费,成交金额,ROI,状态,平台',
  `qn_e2e,${today},cA,计划A,standard,100,1000,50,2.0,100,1.0,running,taobao`,
  `qn_e2e,${today},cB,计划B,standard,300,2000,80,3.75,270,0.9,running,taobao`
].join('\n') + '\n';

test('E2E：CSV 导入 → 建议 → 审核 → 执行 → 对账', async () => {
  // 1) CSV 导入（广告计划）
  const imported = await importCsv(CAMPAIGN_CSV);
  assert.equal(imported.status, 200);
  assert.equal(imported.body.report.type, 'ad_campaign');
  assert.equal(imported.body.report.inserted, 2);
  assert.equal(imported.body.report.failed, 0);

  // 重复导入 → 去重（updated）
  const again = await importCsv(CAMPAIGN_CSV);
  assert.equal(again.body.report.inserted, 0);
  assert.equal(again.body.report.updated, 2);

  // 2) 生成建议（无 AI → 规则引擎）
  const gen = await json(await req('/stores/suggestions/generate?date=' + today, 'POST'));
  assert.ok(gen.count >= 1);

  const list = await json(await req('/stores/suggestions?date=' + today));
  const sug = list.suggestions.find(s => s.shop_id === shopId);
  assert.ok(sug, '未生成建议单');
  assert.equal(sug.prompt_version, 'suggest-v2');
  assert.equal(sug.source, 'rule');
  const actionable = sug.items.find(i => i.action_type === 'adjust_price');
  assert.ok(actionable, '规则引擎应给出调价建议');
  assert.ok(Number(actionable.suggested_value) > 0);

  // 3) 审核通过
  const reviewed = await json(await req('/stores/suggestions/' + sug.id + '/review', 'POST', { action: 'approve_all' }));
  assert.equal(reviewed.status, 'approved');

  // 4) 审核 → 执行清单（默认人工）
  const created = await json(await req('/stores/suggestions/' + sug.id + '/execution-list', 'POST'));
  assert.equal(created.auto, false);
  assert.ok(created.executions.length >= 1);
  assert.ok(created.executions.every(e => e.status === 'pending_manual'));
  const exec = created.executions.find(e => e.action_type === 'adjust_price');
  assert.ok(exec, '应生成调价执行');
  assert.equal(Number(exec.expected_value), Number(actionable.suggested_value));
  assert.equal(Number(exec.before_value), Number(actionable.current_value));

  // 5) 人工回填实际值（差异 0.5）
  const actual = Math.round((Number(exec.expected_value) + 0.5) * 100) / 100;
  const back = await json(await req('/stores/executions/' + exec.id + '/backfill', 'POST', { status: 'success', actual_value: actual }));
  assert.equal(back.execution.status, 'success');
  assert.equal(Number(back.execution.actual_value), actual);

  // 6) 对账
  const rep = await json(await req('/stores/reconcile/report?date_start=' + today + '&date_end=' + today));
  assert.ok(rep.summary.comparable >= 1);
  assert.equal(rep.summary.mismatched, 1);
  assert.equal(rep.summary.sum_abs_diff, 0.5);
  const row = rep.rows.find(r => r.id === exec.id);
  assert.equal(row.matched, false);
  assert.equal(row.diff, 0.5);
});
