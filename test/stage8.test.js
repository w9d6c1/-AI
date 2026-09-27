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

let server, base, token, token2, adminId, otherId, shopId;
let runOwn, runOther, runBadJson;
const today = todayLocal();

before(async () => {
  await runWithTenant(1, async () => {
    adminId = (await defaultAdapter.run('INSERT INTO users (tenant_id,username,password_hash,role) VALUES (?,?,?,?)', [1, 'admin', bcrypt.hashSync('x', 4), 'admin'])).lastInsertRowid;
    otherId = (await defaultAdapter.run('INSERT INTO users (tenant_id,username,password_hash,role) VALUES (?,?,?,?)', [1, 'operator', bcrypt.hashSync('x', 4), 'operator'])).lastInsertRowid;
    shopId = (await defaultAdapter.run('INSERT INTO shops (tenant_id,shop_name,qianniu_account,platform,status,daily_adjust_limit) VALUES (?,?,?,?,?,?)', [1, '阶段8店', 'qn_s8', 'taobao', 'active', 50])).lastInsertRowid;

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

test('S8 工作流：创建、顺序运行、节点快照与跨用户隔离', async () => {
  const created = await json(await req('/agent-workflows', 'POST', {
    name: '选品基础流程',
    description: '回归测试工作流',
    nodes: [
      { key: 'market', agentId: 'a1' },
      { key: 'keywords', agentId: 'a6', inputFrom: 'previous', inputTemplate: '{{workflow_input}}' }
    ]
  }), 201);
  assert.equal(created.definition.nodes.length, 2);
  const list = await json(await req('/agent-workflows'));
  assert.ok(list.workflows.some(w => Number(w.id) === Number(created.id)));
  const run = await json(await req('/agent-workflows/' + created.id + '/run', 'POST', { input: '通勤双肩包', options: { period: '近30天' } }));
  assert.equal(run.status, 'success');
  assert.equal(run.nodes.length, 2);
  assert.ok(run.nodes.every(n => n.status === 'success' && n.runId));
  const runDetail = await json(await req('/agent-workflow-runs/' + run.runId));
  assert.equal(runDetail.nodes.length, 2);
  assert.equal(runDetail.nodes[1].input.input, '通勤双肩包');
  const own = await json(await req('/agent-workflows/' + created.id));
  assert.equal(Number(own.id), Number(created.id));
  const other = await req('/agent-workflows/' + created.id, 'GET', undefined, token2);
  assert.equal(other.status, 404);
  const bad = await req('/agent-workflows', 'POST', { name: '非法流程', nodes: [{ key: 'bad', agentId: 'not-found' }] });
  assert.equal(bad.status, 400);
  const failing = await json(await req('/agent-workflows', 'POST', { name: '失败重试流程', nodes: [{ key: 'image', agentId: 'a9', options: { renderMode: '生成图片' } }] }), 201);
  const failedRun = await json(await req('/agent-workflows/' + failing.id + '/run', 'POST', { input: '测试商品' }));
  assert.equal(failedRun.status, 'failed');
  const retried = await json(await req('/agent-workflow-runs/' + failedRun.runId + '/retry', 'POST', {}));
  assert.equal(retried.status, 'failed');
  const reviewFlow = await json(await req('/agent-workflows', 'POST', { name: '人工审核流程', nodes: [{ key: 'analysis', agentId: 'a13' }, { key: 'review', type: 'approval' }] }, token2), 201);
  const pending = await json(await req('/agent-workflows/' + reviewFlow.id + '/run', 'POST', { input: '审核商品' }, token2));
  assert.equal(pending.status, 'pending_review');
  assert.equal((await req('/agent-workflow-runs/' + pending.runId + '/review', 'POST', { action: 'approved' }, token2)).status, 403);
  const queue = await json(await req('/agent-workflow-runs/pending-review'));
  assert.ok(queue.runs.some(item => Number(item.id) === Number(pending.runId)));
  const selfReviewFlow = await json(await req('/agent-workflows', 'POST', { name: '本人不可自审', nodes: [{ key: 'analysis', agentId: 'a1' }, { key: 'review', type: 'approval' }] }), 201);
  const selfPending = await json(await req('/agent-workflows/' + selfReviewFlow.id + '/run', 'POST', { input: '自审检查' }));
  assert.equal((await req('/agent-workflow-runs/' + selfPending.runId + '/review', 'POST', { action: 'approved' })).status, 403);
  const pendingDetail = await json(await req('/agent-workflow-runs/' + pending.runId));
  assert.equal(Number(pendingDetail.user_id), Number(otherId));
  await runWithTenant(1, async () => {
    await defaultAdapter.run('INSERT INTO ad_campaigns (tenant_id,shop_id,campaign_id,campaign_name,report_date,cost,impressions,clicks,cpc) VALUES (?,?,?,?,?,?,?,?,?)', [1, shopId, 'campaign-review-1', '阶段8候选推广计划', today, 100, 1000, 50, 2]);
    await defaultAdapter.run('UPDATE agent_workflow_nodes SET result_json=? WHERE run_id=? AND node_key=? AND tenant_id=?', [JSON.stringify({ loss_campaigns: [{ campaign: '阶段8候选推广计划' }] }), pending.runId, 'analysis', 1]);
  });
  const approved = await json(await req('/agent-workflow-runs/' + pending.runId + '/review', 'POST', { action: 'approved', note: '已核验' }));
  assert.equal(approved.status, 'success');
  const createdExecutions = await json(await req('/agent-workflow-runs/' + pending.runId + '/execution-drafts', 'POST', {
    actions: [{ shopId, actionType: 'pause', campaignId: 'campaign-review-1', reason: '审核通过后暂停低效计划', nodeKey: 'analysis' }]
  }), 201);
  assert.equal(createdExecutions.executions.length, 1);
  assert.equal(createdExecutions.executions[0].status, 'pending_manual');
  assert.equal(Number(createdExecutions.executions[0].workflow_run_id), Number(pending.runId));
  assert.ok(createdExecutions.batchId);
  assert.equal((await req('/agent-workflow-runs/' + pending.runId + '/execution-drafts', 'POST', {
    actions: [{ shopId, actionType: 'pause', campaignId: 'campaign-review-1', reason: '重复提交' }]
  })).status, 409);
  assert.equal((await req('/agent-workflow-runs/' + pending.runId + '/execution-drafts', 'POST', {
    actions: [{ shopId, actionType: 'pause', campaignId: 'campaign-review-2', reason: '操作员不应创建执行任务' }]
  }, token2)).status, 403);

  const noApproval = await json(await req('/agent-workflows', 'POST', { name: '无审核不可执行', nodes: [{ key: 'analysis', agentId: 'a13' }] }, token2), 201);
  const noApprovalRun = await json(await req('/agent-workflows/' + noApproval.id + '/run', 'POST', { input: '推广计划' }, token2));
  assert.equal(noApprovalRun.status, 'success');
  assert.equal((await req('/agent-workflow-runs/' + noApprovalRun.runId + '/execution-drafts', 'POST', {
    actions: [{ shopId, actionType: 'pause', campaignId: 'campaign-review-1', reason: '应拒绝无审核流程', nodeKey: 'analysis' }]
  })).status, 400);

  const taxFlow = await json(await req('/agent-workflows', 'POST', { name: '财税不生成推广动作', nodes: [{ key: 'tax', agentId: 'a18' }, { key: 'review', type: 'approval' }] }, token2), 201);
  const taxPending = await json(await req('/agent-workflows/' + taxFlow.id + '/run', 'POST', { input: '税务数据' }, token2));
  await json(await req('/agent-workflow-runs/' + taxPending.runId + '/review', 'POST', { action: 'approved' }));
  assert.equal((await req('/agent-workflow-runs/' + taxPending.runId + '/execution-drafts', 'POST', {
    actions: [{ shopId, actionType: 'pause', campaignId: 'campaign-review-1', reason: '财税结果不得创建推广动作', nodeKey: 'tax' }]
  })).status, 400);

  const concurrentFlow = await json(await req('/agent-workflows', 'POST', { name: '并发幂等检查', nodes: [{ key: 'promotion', agentId: 'a13' }, { key: 'review', type: 'approval' }] }, token2), 201);
  const concurrentRun = await json(await req('/agent-workflows/' + concurrentFlow.id + '/run', 'POST', { input: '并发计划检查' }, token2));
  await runWithTenant(1, async () => {
    await defaultAdapter.run('INSERT INTO ad_campaigns (tenant_id,shop_id,campaign_id,campaign_name,report_date,cost,impressions,clicks,cpc) VALUES (?,?,?,?,?,?,?,?,?)', [1, shopId, 'campaign-review-2', '第二个候选推广计划', today, 100, 1000, 50, 2]);
    await defaultAdapter.run('UPDATE agent_workflow_nodes SET result_json=? WHERE run_id=? AND node_key=? AND tenant_id=?', [JSON.stringify({ loss_campaigns: [{ campaign: '阶段8候选推广计划' }, { campaign: '第二个候选推广计划' }] }), concurrentRun.runId, 'promotion', 1]);
  });
  await json(await req('/agent-workflow-runs/' + concurrentRun.runId + '/review', 'POST', { action: 'approved' }));
  const invalidBatch = await req('/agent-workflow-runs/' + concurrentRun.runId + '/execution-drafts', 'POST', { actions: [
    { shopId, actionType: 'pause', campaignId: 'campaign-review-1', reason: '有效候选', nodeKey: 'promotion' },
    { shopId, actionType: 'pause', campaignId: 'campaign-not-in-analysis', reason: '不在分析结果中', nodeKey: 'promotion' }
  ] });
  assert.equal(invalidBatch.status, 400);
  const manualExecutor = require('../server/integrations/executors').get('manual');
  const originalManualExecute = manualExecutor.execute;
  manualExecutor.execute = async item => {
    if (item.campaignId === 'campaign-review-2') throw new Error('测试注入执行器故障');
    return originalManualExecute(item);
  };
  try {
    const brokenBatch = await req('/agent-workflow-runs/' + concurrentRun.runId + '/execution-drafts', 'POST', { actions: [
      { shopId, actionType: 'pause', campaignId: 'campaign-review-1', reason: '事务回滚第一项', nodeKey: 'promotion' },
      { shopId, actionType: 'pause', campaignId: 'campaign-review-2', reason: '事务回滚触发项', nodeKey: 'promotion' }
    ] });
    assert.equal(brokenBatch.status, 500);
  } finally { manualExecutor.execute = originalManualExecute; }
  await runWithTenant(1, async () => {
    const batchRows = await defaultAdapter.get('SELECT COUNT(*) c FROM agent_workflow_execution_batches WHERE tenant_id=? AND workflow_run_id=?', [1, concurrentRun.runId]);
    const executionRows = await defaultAdapter.get('SELECT COUNT(*) c FROM executions WHERE tenant_id=? AND workflow_run_id=?', [1, concurrentRun.runId]);
    assert.equal(Number(batchRows.c), 0, '中途失败应回滚整个批次记录');
    assert.equal(Number(executionRows.c), 0, '中途失败不能留下部分执行任务');
  });
  const duplicatePayload = { actions: [{ shopId, actionType: 'pause', campaignId: 'campaign-review-1', reason: '并发提交测试', nodeKey: 'promotion' }] };
  const concurrentResponses = await Promise.all([
    req('/agent-workflow-runs/' + concurrentRun.runId + '/execution-drafts', 'POST', duplicatePayload),
    req('/agent-workflow-runs/' + concurrentRun.runId + '/execution-drafts', 'POST', duplicatePayload)
  ]);
  assert.deepEqual(concurrentResponses.map(r => r.status).sort(), [201, 409]);
  await runWithTenant(1, async () => {
    const batchRows = await defaultAdapter.get('SELECT COUNT(*) c FROM agent_workflow_execution_batches WHERE tenant_id=? AND workflow_run_id=?', [1, concurrentRun.runId]);
    const executionRows = await defaultAdapter.get('SELECT COUNT(*) c FROM executions WHERE tenant_id=? AND workflow_run_id=?', [1, concurrentRun.runId]);
    assert.equal(Number(batchRows.c), 1);
    assert.equal(Number(executionRows.c), 1);
  });
});
