const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecom-stage4-'));
Object.assign(process.env, {
  DATA_DIR: path.join(root, 'data'), DB_PATH: path.join(root, 'data/ecom-ai.db'), UPLOAD_DIR: path.join(root, 'uploads'),
  JWT_SECRET: crypto.randomBytes(32).toString('hex'), RPA_CALLBACK_TOKEN: 'stage4-token',
  DB_DRIVER: 'sqlite', RPA_MOCK_MODE: 'true', EXECUTOR_DRIVER: 'manual', AUTO_EXECUTE_ENABLED: 'false',
  QUEUE_ENABLED: 'false', STORAGE_DRIVER: 'local', ENABLE_SCHEDULER: 'false',
  SEED_DEFAULT_USERS: 'false', SEED_DEMO_DATA: 'false', ALLOW_REGISTRATION: 'false',
  SUGGEST_MIN_CONFIDENCE: '0.6', SUGGEST_CONCURRENCY: '1',
  AI_API_KEY: 'test-key', AI_IMAGE_API_KEY: '',
  AI_PROVIDERS: JSON.stringify([{ id: 'mock', priority: 1, caps: ['chat'], baseUrl: 'https://mock.ai/v1', apiKeyEnv: 'AI_API_KEY', model: 'mock-1', maxRetries: 0, priceIn: 1, priceOut: 2 }])
});

const app = require('../server/index');
const { defaultAdapter } = require('../server/repositories');
const { runWithTenant } = require('../server/repositories/tenant-context');
const { signToken } = require('../server/middleware');
const { db } = require('../server/db');
const { todayLocal, dateLocalOffset } = require('../server/util');
const { buildContext } = require('../server/inference');
const { validateSuggestionOutput } = require('../server/suggestion');

let server, base, token, adminId, shopId;
const origFetch = global.fetch;
const llmCalls = [];

// LLM mock：命中 mock.ai 时返回结构化 JSON，其余（本地 HTTP）透传
global.fetch = async (url, opts) => {
  if (!String(url).includes('mock.ai')) return origFetch(url, opts);
  let body = {};
  try { body = JSON.parse(opts.body); } catch (_) { /* ignore */ }
  llmCalls.push(body);
  const text = JSON.stringify(body.messages || '');
  const isSuggest = text.includes('广告投放优化专家');
  const content = isSuggest
    ? { shop_summary: '店铺总览', items: [
        { campaign_id: 'c1', action_type: 'pause', suggested_value: null, reason: 'ROI 低', confidence: 0.9 },
        { campaign_id: 'c1', action_type: 'adjust_price', suggested_value: 1, reason: '低置信', confidence: 0.2 }
      ] }
    : { overview: '分析完成', findings: ['f1'], suggestions: ['s1'], expected: 'e1',
        base: { category: '女装', shop: '竞品店', monthlySales: '估算', price: '¥99', rating: '需数据源' },
        dimensions: [1, 2, 3, 4, 5, 6].map(i => ({ label: `维度${i}`, value: 'v', score: i * 10 })),
        radar: { competitor: [10, 20, 30, 40, 50, 60], self: [5, 15, 25, 35, 45, 55] },
        data_source: 'llm' };
  return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 100, completion_tokens: 50 }, model: 'mock-1' }), text: async () => '' };
};

before(async () => {
  await runWithTenant(1, async () => {
    adminId = (await defaultAdapter.run('INSERT INTO users (tenant_id,username,password_hash,role) VALUES (?,?,?,?)', [1, 'admin', bcrypt.hashSync('x', 4), 'admin'])).lastInsertRowid;
    shopId = (await defaultAdapter.run("INSERT INTO shops (tenant_id,shop_name,qianniu_account,platform,status) VALUES (?,?,?,?,?)", [1, '测试店', 'qn_a', 'taobao', 'active'])).lastInsertRowid;
    const today = todayLocal();
    const yest = dateLocalOffset(-1);
    await defaultAdapter.run('INSERT INTO daily_reports (tenant_id,shop_id,report_date,visitors,payed_buyer_count,pay_amount) VALUES (?,?,?,?,?,?)', [1, shopId, today, 100, 10, 1000]);
    await defaultAdapter.run('INSERT INTO daily_reports (tenant_id,shop_id,report_date,visitors,payed_buyer_count,pay_amount) VALUES (?,?,?,?,?,?)', [1, shopId, yest, 200, 20, 2000]);
    await defaultAdapter.run("INSERT INTO ad_campaigns (tenant_id,shop_id,campaign_id,campaign_name,campaign_type,report_date,cost,impressions,clicks,pay_amount,roi,status,platform,account_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [1, shopId, 'c1', '计划1', 'standard', today, 100, 1000, 50, 400, 4, 'running', 'taobao', 'acct_1']);
    await defaultAdapter.run('INSERT INTO orders_daily (tenant_id,shop_id,report_date,order_count,payed_order_count,pay_amount,refund_order_count,refund_amount) VALUES (?,?,?,?,?,?,?,?)', [1, shopId, today, 40, 30, 1000, 2, 50]);
    await defaultAdapter.run('INSERT INTO refunds_daily (tenant_id,shop_id,report_date,refund_count,refund_amount,refund_rate) VALUES (?,?,?,?,?,?)', [1, shopId, today, 3, 60, 0.02]);
    await defaultAdapter.run('INSERT INTO products (tenant_id,shop_id,product_id,title,price,platform) VALUES (?,?,?,?,?,?)', [1, shopId, 'p1', '商品一', 99, 'taobao']);
    await defaultAdapter.run('INSERT INTO product_daily (tenant_id,shop_id,product_id,report_date,pay_amount) VALUES (?,?,?,?,?)', [1, shopId, 'p1', today, 800]);
    token = await signToken({ id: adminId, tenant_id: 1, session_version: 0 });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});

after(async () => {
  global.fetch = origFetch;
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  try { db.close(); } catch (_) { /* ignore */ }
  const resolved = path.resolve(root);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('ecom-stage4-')) fs.rmSync(resolved, { recursive: true, force: true });
});

async function req(url, method = 'GET', body) {
  const headers = { Authorization: 'Bearer ' + token };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return origFetch(base + '/api' + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function json(resp, status = 200) { assert.equal(resp.status, status, await resp.clone().text()); return resp.json(); }

test('P4-1 数据看板真实聚合', async () => {
  const d = await json(await req('/dashboard/stats?range=7d'));
  assert.equal(d.metrics.sales, 3000);
  assert.equal(d.metrics.uv, 300);
  assert.equal(d.metrics.cvr, 10);
  assert.equal(d.metrics.roi, 4);
  assert.equal(d.metrics.orders, 30);
  assert.equal(d.metrics.refunds, 3);
  assert.equal(d.metrics.refund_amount, 60);
  assert.ok(d.trend.length >= 1);
  assert.ok(d.channels.some(c => c.name === '标准推广' && c.value === 100));
  assert.ok(d.ad.weeks.length >= 1);
  assert.equal(d.topProducts[0].name, '商品一');
  assert.equal(d.topProducts[0].value, 800);
});

test('P4-1 看板：按广告账号与平台聚合（多平台看板）', async () => {
  const d = await json(await req('/dashboard/stats?range=7d'));
  assert.ok(Array.isArray(d.accounts));
  const acc = d.accounts.find(a => a.account_id === 'acct_1');
  assert.ok(acc, '应包含广告账号 acct_1');
  assert.equal(acc.platform, 'taobao');
  assert.equal(acc.cost, 100);
  assert.equal(acc.pay, 400);
  assert.equal(acc.roi, 4);
  assert.equal(acc.campaigns, 1);

  assert.ok(Array.isArray(d.platforms));
  const plat = d.platforms.find(p => p.platform === 'taobao');
  assert.ok(plat, '应包含平台 taobao');
  assert.equal(plat.cost, 100);
  assert.equal(plat.pay, 400);
  assert.equal(plat.roi, 4);
  assert.equal(plat.campaigns, 1);
});

test('P4-3 buildContext 注入订单/退款/商品/趋势', async () => {
  await runWithTenant(1, async () => {
    const ctx = await buildContext('a2', 'x', adminId);
    assert.ok(ctx.includes('订单数据'), ctx.slice(0, 200));
    assert.ok(ctx.includes('退款数据'));
    assert.ok(ctx.includes('商品TOP5'));
    assert.ok(ctx.includes('销售趋势'));
  });
});

test('P4-4 建议引擎：schema 校验 + 置信度阈值 + 版本落库', async () => {
  const validIds = new Set(['c1']);
  const v = validateSuggestionOutput({ items: [
    { campaign_id: 'c1', action_type: 'pause', confidence: 0.9 },
    { campaign_id: 'cX', action_type: 'pause', confidence: 0.9 },
    { campaign_id: 'c1', action_type: 'bad', confidence: 0.9 },
    { campaign_id: 'c1', action_type: 'adjust_price', suggested_value: 1.2, confidence: 2 }
  ] }, validIds);
  assert.equal(v.items.length, 2);
  assert.equal(v.items[1].confidence, 1);
  assert.ok(v.errors.length >= 2);

  const today = todayLocal();
  const count = await runWithTenant(1, async () => require('../server/suggestion').generateSuggestions(today));
  assert.equal(count, 1);
  await runWithTenant(1, async () => {
    const s = await defaultAdapter.get('SELECT * FROM suggestions WHERE tenant_id=? AND shop_id=? AND suggestion_date=?', [1, shopId, today]);
    assert.equal(s.prompt_version, 'suggest-v2');
    assert.equal(s.source, 'llm');
    assert.equal(s.model, 'mock-1');
    assert.equal(s.excluded_items, 1);
    const items = await defaultAdapter.all('SELECT * FROM suggestion_items WHERE tenant_id=? AND suggestion_id=?', [1, s.id]);
    assert.equal(items.length, 1);
    assert.equal(items[0].action_type, 'pause');
  });
});

test('P4-5 用量/成本统计', async () => {
  const run = await json(await req('/agents/a3/run', 'POST', { input: '测试商品' }));
  assert.equal(run.source, 'llm');
  assert.equal(run.provider, 'mock');
  assert.ok(run.cost > 0);
  const usage = await json(await req('/usage/stats'));
  assert.ok(usage.usage.some(u => u.provider === 'mock' && u.capability === 'chat'));
  assert.ok(usage.agent_runs.runs >= 1);
  assert.ok(usage.agent_runs.cost > 0);
  assert.ok(usage.agent_runs.by_agent.some(a => a.agent_id === 'a3'));
});

test('P4-2 竞品分析真实化（LLM，结构兼容）', async () => {
  const r = await json(await req('/competitor', 'POST', { target: '竞品链接A' }));
  assert.equal(r.source, 'llm');
  assert.equal(r.report.dimensions.length, 6);
  assert.equal(r.report.radar.competitor.length, 6);
  assert.equal(r.report.radar.self.length, 6);
  assert.ok(Array.isArray(r.report.suggestions));
  assert.equal(r.report.data_source, 'llm');
});

test('P4-6 知识库 RAG：索引、检索、对话注入', async () => {
  const doc = await json(await req('/kb-docs', 'POST', { name: '运营手册', content: '退款率优化：当退款率超过5%时，需要检查尺码表和质检报告。' }));
  assert.ok(doc.chunks >= 1);

  const search = await json(await req('/kb-search', 'POST', { query: '退款率' }));
  assert.ok(search.results.length >= 1);
  assert.ok(search.results[0].content.includes('退款率'));

  const chat = await json(await req('/chats', 'POST', { title: 't' }));
  const msg = await json(await req('/chats/' + chat.chat.id + '/messages', 'POST', { content: '退款率怎么优化？' }));
  assert.equal(msg.aiSource, 'llm');
  assert.ok(msg.kb_used >= 1);
});

test('P4-6 知识库归属：检索仅限本人文档', async () => {
  const other = (await runWithTenant(1, async () => (await defaultAdapter.run('INSERT INTO users (tenant_id,username,password_hash,role) VALUES (?,?,?,?)', [1, 'bob', bcrypt.hashSync('x', 4), 'member'])).lastInsertRowid));
  const otherToken = await runWithTenant(1, async () => signToken({ id: other, tenant_id: 1, session_version: 0 }));
  const resp = await origFetch(base + '/api/kb-search', { method: 'POST', headers: { Authorization: 'Bearer ' + otherToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '退款率' }) });
  const body = await resp.json();
  assert.deepEqual(body.results, []);
});

test('P4-6 智能体执行注入知识库（RAG）', async () => {
  llmCalls.length = 0;
  await json(await req('/agents/a3/run', 'POST', { input: '退款率优化' }));
  const sent = JSON.stringify(llmCalls[llmCalls.length - 1] || {});
  assert.ok(sent.includes('知识库参考'), '智能体 prompt 未注入知识库');
  assert.ok(sent.includes('退款率优化'));
});

test('P4-1 看板支持 shop_ids 筛选与越权拒绝', async () => {
  const ok = await json(await req('/dashboard/stats?shop_ids=[' + shopId + ']'));
  assert.equal(ok.metrics.sales, 3000);
  const denied = await req('/dashboard/stats?shop_ids=[999999]');
  assert.equal(denied.status, 403);
  const bad = await req('/dashboard/stats?shop_ids=oops');
  assert.equal(bad.status, 400);
});
