// ===== 阶段 8 · 新增 UI 依赖接口回归（导出/批量回填/知识库检索/报表模板/数据保留）=====
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecom-stage8ui-'));
Object.assign(process.env, {
  DATA_DIR: path.join(root, 'data'), DB_PATH: path.join(root, 'data/ecom-ai.db'), UPLOAD_DIR: path.join(root, 'uploads'),
  JWT_SECRET: crypto.randomBytes(32).toString('hex'), RPA_CALLBACK_TOKEN: 'stage8ui-token',
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

let server, base, token, tokenMember, tokenSuper, shopId, exec1, exec2;

before(async () => {
  await runWithTenant(1, async () => {
    const adminId = (await defaultAdapter.run('INSERT INTO users (tenant_id,username,password_hash,role) VALUES (?,?,?,?)', [1, 'admin', bcrypt.hashSync('x', 4), 'admin'])).lastInsertRowid;
    const memberId = (await defaultAdapter.run('INSERT INTO users (tenant_id,username,password_hash,role) VALUES (?,?,?,?)', [1, 'member', bcrypt.hashSync('x', 4), 'member'])).lastInsertRowid;
    const superId = (await defaultAdapter.run('INSERT INTO users (tenant_id,username,password_hash,role) VALUES (?,?,?,?)', [1, 'root', bcrypt.hashSync('x', 4), 'superadmin'])).lastInsertRowid;
    shopId = (await defaultAdapter.run('INSERT INTO shops (tenant_id,shop_name,qianniu_account,platform,status,daily_adjust_limit) VALUES (?,?,?,?,?,?)', [1, 'UI店', 'qn_s8ui', 'taobao', 'active', 50])).lastInsertRowid;
    exec1 = (await defaultAdapter.run("INSERT INTO executions (tenant_id,shop_id,action_type,target_campaign_id,status,expected_value,before_value) VALUES (?,?,?,?,?,?,?)", [1, shopId, 'adjust_price', 'c1', 'pending_manual', 12, 10])).lastInsertRowid;
    exec2 = (await defaultAdapter.run("INSERT INTO executions (tenant_id,shop_id,action_type,target_campaign_id,status,expected_value,before_value) VALUES (?,?,?,?,?,?,?)", [1, shopId, 'pause', 'c2', 'pending_manual', null, null])).lastInsertRowid;
    token = await signToken({ id: adminId, tenant_id: 1, session_version: 0 });
    tokenMember = await signToken({ id: memberId, tenant_id: 1, session_version: 0 });
    tokenSuper = await signToken({ id: superId, tenant_id: 1, session_version: 0 });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});

after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  try { db.close(); } catch (_) { /* ignore */ }
  const resolved = path.resolve(root);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('ecom-stage8ui-')) fs.rmSync(resolved, { recursive: true, force: true });
});

async function req(url, method = 'GET', body, tok = token) {
  const headers = { Authorization: 'Bearer ' + tok };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(base + '/api' + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function json(resp, status = 200) { assert.equal(resp.status, status, await resp.clone().text()); return resp.json(); }
async function upload(url, csvText, tok = token) {
  const form = new FormData();
  form.append('file', new Blob([csvText], { type: 'text/csv' }), 'data.csv');
  return fetch(base + '/api' + url, { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: form });
}

test('S8-UI 导出执行清单：CSV 带 BOM / Excel 类型正确', async () => {
  const csvResp = await req('/stores/executions/export?status=pending_manual&format=csv');
  assert.equal(csvResp.status, 200);
  assert.match(csvResp.headers.get('content-type'), /text\/csv/);
  const buf = Buffer.from(await csvResp.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'CSV 应带 UTF-8 BOM');
  const text = buf.toString('utf8');
  assert.ok(text.includes('execution_id'));
  assert.ok(text.includes(String(exec1)));

  const xlsResp = await req('/stores/executions/export?status=pending_manual&format=xls');
  assert.equal(xlsResp.status, 200);
  assert.match(xlsResp.headers.get('content-type'), /vnd\.ms-excel/);
});

test('S8-UI 批量回填：成功/失败统计与错误明细，并落库', async () => {
  const csv = [
    'execution_id,status,actual_value,note',
    `${exec1},success,12.5,已人工执行`,
    `${exec2},bogus,1,`,
    '999999,success,1,'
  ].join('\n') + '\n';
  const resp = await upload('/stores/executions/backfill', csv);
  const body = await resp.json();
  assert.equal(resp.status, 200, JSON.stringify(body));
  assert.equal(body.success, 1);
  assert.equal(body.failed, 2);
  assert.equal(body.errors.length, 2);

  const row = await runWithTenant(1, () => defaultAdapter.get('SELECT status, actual_value FROM executions WHERE id=? AND tenant_id=?', [exec1, 1]));
  assert.equal(row.status, 'success');
  assert.equal(Number(row.actual_value), 12.5);
});

test('S8-UI 知识库检索：空查询 400；命中片段带相关度', async () => {
  assert.equal((await req('/kb-search', 'POST', { query: '   ' })).status, 400);

  const doc = await json(await req('/kb-docs', 'POST', { name: '售后手册', content: '退货政策：支持7天无理由退货，商品需保持完好。退款将在3个工作日到账。' }));
  assert.ok(doc.doc.id);

  const search = await json(await req('/kb-search', 'POST', { query: '退货政策', top_k: 3 }));
  assert.ok(search.results.length >= 1);
  assert.ok(search.results[0].score > 0);
  assert.ok(search.results[0].content.includes('退货'));
});

test('S8-UI 报表模板：创建/列表/越权删除 404/管理员删除', async () => {
  const created = await json(await req('/report-templates', 'POST', { name: '每日日报模板', report_type: 'daily_summary', is_default: true }), 201);
  const tplId = created.template.id;

  const list = await json(await req('/report-templates'));
  assert.ok(list.templates.some(t => t.id === tplId));

  assert.equal((await req('/report-templates/' + tplId, 'DELETE', undefined, tokenMember)).status, 404);

  const del = await json(await req('/report-templates/' + tplId, 'DELETE'));
  assert.equal(del.ok, true);
  const after = await json(await req('/report-templates'));
  assert.ok(!after.templates.some(t => t.id === tplId));
});

test('S8-UI 数据保留：非超管 403；超管可查看策略并执行清理', async () => {
  assert.equal((await req('/admin/retention/policy', 'GET', undefined, tokenMember)).status, 403);
  assert.equal((await req('/admin/retention/policy', 'GET', undefined, token)).status, 403);

  const policy = await json(await req('/admin/retention/policy', 'GET', undefined, tokenSuper));
  assert.ok(Array.isArray(policy.policies) && policy.policies.length >= 1);
  assert.ok(policy.policies[0].table && policy.policies[0].column);

  const run = await json(await req('/admin/retention/run', 'POST', undefined, tokenSuper));
  assert.ok(run.summary && typeof run.summary === 'object');
});
