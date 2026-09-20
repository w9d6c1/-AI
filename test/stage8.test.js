// ===== 阶段 8：新增视图依赖的接口回归 =====
// 覆盖：CSV 导入模板/批次列表/批次详情、智能体运行历史（列表/详情/校验）、用量统计。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecom-stage8-'));
Object.assign(process.env, {
  DATA_DIR: path.join(root, 'data'), DB_PATH: path.join(root, 'data/ecom-ai.db'), UPLOAD_DIR: path.join(root, 'uploads'),
  JWT_SECRET: crypto.randomBytes(32).toString('hex'), RPA_CALLBACK_TOKEN: 'stage8-token',
  DB_DRIVER: 'sqlite', RPA_MOCK_MODE: 'true', EXECUTOR_DRIVER: 'manual', AUTO_EXECUTE_ENABLED: 'false',
  QUEUE_ENABLED: 'false', STORAGE_DRIVER: 'local', ENABLE_SCHEDULER: 'false',
  SEED_DEFAULT_USERS: 'false', SEED_DEMO_DATA: 'false', ALLOW_REGISTRATION: 'false',
  AI_API_KEY: '', AI_IMAGE_API_KEY: '', AI_PROVIDERS: '', SCAN_UPLOADS: 'false'
});

const app = require('../server/index');
const { defaultAdapter } = require('../server/repositories');
const { runWithTenant } = require('../server/repositories/tenant-context');
const { signToken } = require('../server/middleware');
const { db } = require('../server/db');
const { todayLocal } = require('../server/util');

let server, base, token, token2, adminId, otherId;
let runOwn, runOther, runBadJson;
const today = todayLocal();

before(async () => {
  await runWithTenant(1, async () => {
    adminId = (await defaultAdapter.run('INSERT INTO users (tenant_id,username,password_hash,role) VALUES (?,?,?,?)', [1, 'admin', bcrypt.hashSync('x', 4), 'admin'])).lastInsertRowid;
    otherId = (await defaultAdapter.run('INSERT INTO users (tenant_id,username,password_hash,role) VALUES (?,?,?,?)', [1, 'operator', bcrypt.hashSync('x', 4), 'operator'])).lastInsertRowid;
    await defaultAdapter.run('INSERT INTO shops (tenant_id,shop_name,qianniu_account,platform,status,daily_adjust_limit) VALUES (?,?,?,?,?,?)', [1, '阶段8店', 'qn_s8', 'taobao', 'active', 50]);

    const runSql = 'INSERT INTO agent_runs (tenant_id,user_id,agent_id,agent_name,input,result,result_parsed,source,tokens_est,duration_ms,provider,model,tokens_in,tokens_out,cost) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)';
    runOwn = (await defaultAdapter.run(runSql, [1, adminId, 'a1', '蓝海探测智能体', '连衣裙', 'raw-own', JSON.stringify({ ok: true, items: [1, 2] }), 'rule', 12, 8, 'local', 'm1', 5, 7, 0.02])).lastInsertRowid;
    runOther = (await defaultAdapter.run(runSql, [1, otherId, 'a1', '蓝海探测智能体', '卫衣', 'raw-other', JSON.stringify({ ok: true }), 'rule', 12, 8, 'local', 'm1', 5, 7, 0.02])).lastInsertRowid;
    runBadJson = (await defaultAdapter.run(runSql, [1, adminId, 'a2', '智能选款智能体', '牛仔裤', 'raw-bad', '{bad json', 'rule', 12, 8, 'local', 'm1', 5, 7, 0.02])).lastInsertRowid;

    await defaultAdapter.run('INSERT INTO ai_usage (tenant_id,provider,capability,model,tokens_in,tokens_out,cost) VALUES (?,?,?,?,?,?,?)', [1, 'local', 'chat', 'm1', 5, 7, 0.02]);
    await defaultAdapter.run('INSERT INTO ai_usage (tenant_id,provider,capability,model,tokens_in,tokens_out,cost) VALUES (?,?,?,?,?,?,?)', [1, 'local', 'image', 'img1', 0, 0, 0.05]);

    token = await signToken({ id: adminId, tenant_id: 1, session_version: 0 });
    token2 = await signToken({ id: otherId, tenant_id: 1, session_version: 0 });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});

after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  try { db.close(); } catch (_) { /* ignore */ }
  const resolved = path.resolve(root);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('ecom-stage8-')) fs.rmSync(resolved, { recursive: true, force: true });
});

async function req(url, method = 'GET', body, tok = token) {
  const headers = { Authorization: 'Bearer ' + tok };
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

const DAILY_HEADER = '千牛账号,日期,访客数,支付买家数,支付金额,支付件数,转化率,客单价';

test('S8 导入：类型清单与模板下载（含 BOM、非法类型 400）', async () => {
  const types = await json(await req('/stores/import/types'));
  assert.ok(types.types.some(t => t.value === 'daily_report'));

  const bad = await req('/stores/import/template?type=bogus');
  assert.equal(bad.status, 400);

  const resp = await req('/stores/import/template?type=daily_report');
  assert.equal(resp.status, 200);
  assert.match(resp.headers.get('content-type'), /text\/csv/);
  const buf = Buffer.from(await resp.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 3)], [0xEF, 0xBB, 0xBF], '模板应带 UTF-8 BOM');
  assert.ok(buf.toString('utf8').includes('千牛账号'));
});

test('S8 导入：批次列表与详情（成功批次 / 失败批次错误明细 / 不存在 404）', async () => {
  const ok = await importCsv(`${DAILY_HEADER}\nqn_s8,${today},1200,36,3600,42,0.03,100\n`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.report.status, 'success');
  assert.equal(ok.body.report.inserted, 1);
  const okId = ok.body.report.batchId;

  const list = await json(await req('/stores/import/batches'));
  const found = list.batches.find(b => b.id === okId);
  assert.ok(found, '批次列表应包含刚导入的批次');
  assert.equal(found.file_name, 'data.csv');
  assert.equal(found.success_rows, 1);

  const detail = await json(await req('/stores/import/batches/' + okId));
  assert.equal(detail.batch.id, okId);
  assert.deepEqual(detail.batch.errors_json, []);
  assert.deepEqual(detail.batch.warnings_json, []);
  assert.equal(detail.batch.summary_json.type, 'daily_report');

  const failed = await importCsv(`${DAILY_HEADER}\nqn_missing,${today},10,1,100,1,0.1,100\n`);
  assert.equal(failed.status, 422);
  assert.equal(failed.body.report.status, 'failed');
  const failedDetail = await json(await req('/stores/import/batches/' + failed.body.report.batchId));
  assert.ok(Array.isArray(failedDetail.batch.errors_json));
  assert.ok(failedDetail.batch.errors_json.length >= 1);

  assert.equal((await req('/stores/import/batches/999999')).status, 404);
});

test('S8 运行历史：仅返回本人记录、按时间倒序、结构化结果解析（非法 JSON 兜底 null）', async () => {
  const mine = await json(await req('/agent-runs'));
  assert.ok(mine.runs.every(r => r.id !== runOther), '不应看到其他用户的运行记录');
  assert.equal(mine.runs[0].id, runBadJson, '最新记录在前');
  assert.equal(mine.runs[1].id, runOwn);
  assert.equal(mine.runs[1].result_parsed.ok, true);
  assert.deepEqual(mine.runs[1].result_parsed.items, [1, 2]);
  assert.equal(mine.runs[0].result_parsed, null, '非法 JSON 应兜底为 null');
});

test('S8 运行历史：详情归属校验（本人 200 / 他人与不存在 404）', async () => {
  const own = await json(await req('/agent-runs/' + runOwn));
  assert.equal(own.id, runOwn);
  assert.equal(own.agent_name, '蓝海探测智能体');
  assert.equal(own.result_parsed.ok, true);

  assert.equal((await req('/agent-runs/' + runOther)).status, 404);
  assert.equal((await req('/agent-runs/' + runOwn, 'GET', undefined, token2)).status, 404);
  assert.equal((await req('/agent-runs/999999')).status, 404);
});

test('S8 智能体执行：未知智能体 404、空输入 400', async () => {
  assert.equal((await req('/agents/nope/run', 'POST', { input: 'x' })).status, 404);
  assert.equal((await req('/agents/a1/run', 'POST', { input: '   ' })).status, 400);
  assert.equal((await req('/agents/a1/run', 'POST', {})).status, 400);
});

test('S8 用量统计：按 provider/能力/模型聚合 + 智能体维度 + 日期区间过滤', async () => {
  const stats = await json(await req('/usage/stats?date_start=' + today + '&date_end=' + today));
  assert.equal(stats.date_range.start, today);
  assert.equal(stats.usage.length, 2);
  const chat = stats.usage.find(u => u.model === 'm1');
  assert.equal(chat.calls, 1);
  assert.equal(Number(chat.cost), 0.02);

  assert.equal(stats.agent_runs.runs, 3);
  assert.equal(stats.agent_runs.tokens_in, 15);
  assert.equal(stats.agent_runs.tokens_out, 21);
  assert.ok(Math.abs(Number(stats.agent_runs.cost) - 0.06) < 1e-9);
  assert.equal(stats.agent_runs.by_agent[0].agent_id, 'a1');
  assert.equal(stats.agent_runs.by_agent[0].runs, 2);

  const empty = await json(await req('/usage/stats?date_start=2000-01-01&date_end=2000-01-02'));
  assert.equal(empty.usage.length, 0);
  assert.equal(empty.agent_runs.runs, 0);
});
