const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecom-agents-'));
Object.assign(process.env, {
  DATA_DIR: path.join(root, 'data'), DB_PATH: path.join(root, 'data/ecom-ai.db'), UPLOAD_DIR: path.join(root, 'uploads'),
  JWT_SECRET: crypto.randomBytes(32).toString('hex'), DB_DRIVER: 'sqlite',
  QUEUE_ENABLED: 'false', STORAGE_DRIVER: 'local', ENABLE_SCHEDULER: 'false',
  SEED_DEFAULT_USERS: 'false', SEED_DEMO_DATA: 'false', ALLOW_REGISTRATION: 'false',
  AI_API_KEY: '', AI_IMAGE_API_KEY: '', AI_PROVIDERS: ''
});

const { db } = require('../server/db');
const { runWithTenant } = require('../server/repositories/tenant-context');
const { runAgent, buildContext } = require('../server/inference');
const { AGENT_PROMPTS, getAgentCatalog, getAgentPrompt } = require('../server/agent-prompts');
const { validateSuggestionOutput, SUGGEST_PROMPT_VERSION } = require('../server/suggestion');

const AGENT_IDS = Object.keys(AGENT_PROMPTS);

after(() => {
  try { db.close(); } catch (_) { /* ignore */ }
  const resolved = path.resolve(root);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('ecom-agents-')) fs.rmSync(resolved, { recursive: true, force: true });
});

test('P4-7 智能体注册表完整性', () => {
  const catalog = getAgentCatalog();
  assert.ok(AGENT_IDS.length >= 19);
  for (const id of AGENT_IDS) {
    const c = getAgentPrompt(id);
    assert.ok(c.name && c.systemPrompt && c.userTemplate, `${id} 定义不完整`);
    assert.ok(catalog[id], `${id} 未进入目录`);
    assert.ok(['json', 'text'].includes(c.outputFormat));
  }
  assert.ok(getAgentPrompt('a19'), '竞品分析智能体缺失');
});

test('P4-7 回归集：无 AI 时全部智能体走模板且输出可解析', async () => {
  for (const id of AGENT_IDS) {
    const r = await runWithTenant(1, () => runAgent(id, '回归测试输入', { userId: null }));
    assert.equal(r.source, 'template', `${id} 应为模板来源`);
    assert.ok(r.result && typeof r.result === 'object', `${id} 结果非对象`);
    assert.ok(!r.result.parse_error, `${id} 输出解析失败`);
    assert.ok(r.result.overview, `${id} 缺少 overview`);
    assert.ok(r.duration_ms >= 0);
  }
});

test('P4-7 竞品模板结构兼容前端（dimensions/radar）', async () => {
  const r = await runWithTenant(1, () => runAgent('a19', '竞品X', { userId: null }));
  assert.equal(r.result.dimensions.length, 6);
  assert.equal(r.result.radar.competitor.length, 6);
  assert.equal(r.result.radar.self.length, 6);
  assert.ok(Array.isArray(r.result.suggestions));
  assert.equal(r.result.data_source, 'framework');
});

test('P4-3 buildContext：无店铺数据需求的智能体返回空上下文', async () => {
  const ctx = await runWithTenant(1, () => buildContext('a1', 'x', null));
  assert.equal(ctx, '');
});

test('P4-4 建议 schema 校验：非法项被剔除', () => {
  assert.equal(SUGGEST_PROMPT_VERSION, 'suggest-v2');
  const v = validateSuggestionOutput({ items: [
    { campaign_id: 'c1', action_type: 'pause', confidence: 0.5 },
    { campaign_id: 'c2', action_type: 'no_change', confidence: -1 },
    { campaign_id: 'c1', action_type: 'unknown', confidence: 0.9 }
  ] }, new Set(['c1', 'c2']));
  assert.equal(v.items.length, 2);
  assert.equal(v.items[1].confidence, 0);
  assert.equal(v.ok, true);
  assert.equal(validateSuggestionOutput(null, new Set()).ok, false);
  assert.equal(validateSuggestionOutput({ items: 'x' }, new Set()).ok, false);
});
