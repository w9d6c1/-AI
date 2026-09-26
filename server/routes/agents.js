// ===== 智能体路由（对接推理层） =====
const express = require('express');
const { repos } = require('../repositories');
const { requireTenant } = require('../repositories/tenant-context');
const { enforceAiQuota, enforceUsageQuota } = require('../quota');
const { authRequired, asyncH } = require('../middleware');
const { runAgent } = require('../inference');
const { getAgentCatalog } = require('../agent-prompts');
const { getStats, getProviderInfo, aiEnabled } = require('../ai');
const { todayLocal, dateLocalOffset } = require('../util');
const { getWorkbench, validateRequest } = require('../agent-workbench');
const { executeAgent, readRun } = require('../agent-execution');

const router = express.Router();
router.use(authRequired);

// 智能体目录（前端展示用，与 agent-prompts.js 中的注册表保持一致）
const AGENTS = [
  { cat: '市场选款', items: [
    { id: 'a1', name: '蓝海探测智能体', icon: '🔍', color: '#f0fdfa', desc: '挖掘低竞争高增长赛道，快速定位蓝海机会词', tags: ['数据驱动', '趋势分析'] },
    { id: 'a2', name: '智能选款智能体', icon: '📊', color: '#eff6ff', desc: '多维数据交叉分析，自动识别高利润爆款与亏损款', tags: ['数据驱动', '利润分析'] },
    { id: 'a3', name: '商品诊断智能体', icon: '🩺', color: '#fffbeb', desc: '全链路诊断商品问题，给出可执行的优化方案', tags: ['诊断', '数据驱动'] },
    { id: 'a19', name: '竞品分析智能体', icon: '⚔️', color: '#fef2f2', desc: '结合自有数据的竞品对比与差异化建议（数据不足时标注）', tags: ['竞品', '数据驱动'] }
  ]},
  { cat: '产品调研', items: [
    { id: 'a4', name: '评价分析智能体', icon: '💬', color: '#f0fdfa', desc: '提取全量评价关键词，精准定位用户痛点与卖点', tags: ['NLP', '评价挖掘'] },
    { id: 'a5', name: '问大家分析智能体', icon: '❓', color: '#eff6ff', desc: '分析买家疑问，挖掘产品改进与详情页优化方向', tags: ['NLP', '需求洞察'] },
    { id: 'a6', name: '关键词需求分析', icon: '📈', color: '#fffbeb', desc: '行业关键词全景分析，识别需求趋势与竞争格局', tags: ['数据驱动', '关键词'] }
  ]},
  { cat: '视觉营销', items: [
    { id: 'a7', name: '标题制作智能体', icon: '✏️', color: '#f0fdfa', desc: '基于搜索权重算法，生成高流量高转化商品标题', tags: ['生成', 'SEO'] },
    { id: 'a8', name: '主图策划智能体', icon: '🖼️', color: '#eff6ff', desc: '竞品主图拆解 + 卖点提炼，输出主图策划方案', tags: ['策划', '视觉'] },
    { id: 'a9', name: '主图生成智能体', icon: '🎨', color: '#fffbeb', desc: 'AI 生成多版本主图方案，支持批量导出', tags: ['生成', '图片'] },
    { id: 'a10', name: '详情页策划智能体', icon: '📄', color: '#fef2f2', desc: '结构化详情页逻辑设计，从痛点到信任全链路覆盖', tags: ['策划', '转化'] },
    { id: 'a11', name: '详情页生成智能体', icon: '🖌️', color: '#f0fdfa', desc: 'AI 生成完整详情页，支持多风格批量产出', tags: ['生成', '文案'] },
    { id: 'a12', name: '买家秀生成智能体', icon: '📸', color: '#eff6ff', desc: '生成真实感买家秀图片，提升详情页信任度', tags: ['生成', '图片'] }
  ]},
  { cat: '运营推广', items: [
    { id: 'a13', name: '推广分析智能体', icon: '💰', color: '#fffbeb', desc: '深度拆解推广数据，定位亏损根源并给出优化方案', tags: ['数据驱动', 'ROI'] },
    { id: 'a14', name: '万相台推广智能体', icon: '🚀', color: '#f0fdfa', desc: '智能调控万相台预算分配，最大化投产比', tags: ['数据驱动', '自动化'] },
    { id: 'a15', name: '流量渠道智能体', icon: '🌐', color: '#eff6ff', desc: '全渠道流量结构分析，优化流量来源配比', tags: ['数据驱动', '流量'] },
    { id: 'a16', name: '地域诊断智能体', icon: '🗺️', color: '#fef2f2', desc: '分地域转化与 ROI 分析，指导精准投放', tags: ['诊断', '地域'] }
  ]},
  { cat: '内容生成', items: [
    { id: 'a17', name: 'AI 文案生成智能体', icon: '📝', color: '#f0fdfa', desc: '生成商品文案、推广文案、短视频脚本等多类型内容', tags: ['生成', '多场景'] }
  ]},
  { cat: '数智财税', items: [
    { id: 'a18', name: '税务风险诊断智能体', icon: '⚖️', color: '#fef2f2', desc: '基于交易数据与最新政策，自动识别税务风险并生成合规报告', tags: ['诊断', '合规'] }
  ]}
];

// 智能体目录
router.get('/agents', (req, res) => {
  res.json({ agents: AGENTS.map(group => ({ ...group, items: group.items.map(item => {
    const workbench = getWorkbench(item.id);
    return { ...item, ...(workbench ? { desc: workbench.description, workbench } : {}) };
  }) })) });
});

// 推理层状态：提供商信息 + 用量统计
router.get('/agents/inference-info', (req, res) => {
  res.json({
    provider: getProviderInfo(),
    stats: getStats(),
    ai_enabled: aiEnabled()
  });
});

// 用量/成本统计（P4-5）：按 provider/能力/模型与智能体聚合
router.get('/usage/stats', asyncH(async (req, res) => {
  const t = requireTenant();
  const start = req.query.date_start || dateLocalOffset(-30);
  const end = req.query.date_end || todayLocal();
  const endTs = end + ' 23:59:59';
  const usage = await repos.adapter.all(
    `SELECT provider, capability, model, COUNT(*) calls, COALESCE(SUM(tokens_in),0) tokens_in, COALESCE(SUM(tokens_out),0) tokens_out, COALESCE(SUM(cost),0) cost
     FROM ai_usage WHERE tenant_id=? AND created_at >= ? AND created_at <= ? GROUP BY provider, capability, model ORDER BY cost DESC`,
    [t, start, endTs]
  );
  const runs = (await repos.adapter.get(
    `SELECT COUNT(*) runs, COALESCE(SUM(tokens_in),0) tokens_in, COALESCE(SUM(tokens_out),0) tokens_out, COALESCE(SUM(cost),0) cost
     FROM agent_runs WHERE tenant_id=? AND created_at >= ? AND created_at <= ?`,
    [t, start, endTs]
  )) || {};
  const byAgent = await repos.adapter.all(
    `SELECT agent_id, agent_name, COUNT(*) runs, COALESCE(SUM(tokens_in),0) tokens_in, COALESCE(SUM(tokens_out),0) tokens_out, COALESCE(SUM(cost),0) cost
     FROM agent_runs WHERE tenant_id=? AND created_at >= ? AND created_at <= ? GROUP BY agent_id, agent_name ORDER BY cost DESC`,
    [t, start, endTs]
  );
  res.json({
    date_range: { start, end },
    usage,
    agent_runs: { runs: Number(runs.runs || 0), tokens_in: Number(runs.tokens_in || 0), tokens_out: Number(runs.tokens_out || 0), cost: Number(runs.cost || 0), by_agent: byAgent },
    in_memory: getStats()
  });
}));

// 执行智能体（通过推理层）
router.post('/agents/:id/run', asyncH(async (req, res) => {
  res.json(await executeAgent(req.user, req.params.id, req.body));
}));

router.post('/agents/:id/batch', asyncH(async (req, res) => {
  const { id } = req.params;
  if (!getWorkbench(id)?.supportsBatch) return res.status(400).json({ error: '该智能体不支持批量分析' });
  const items = req.body?.items;
  if (!Array.isArray(items) || !items.length || items.length > 5) return res.status(400).json({ error: '每批支持 1–5 个任务' });
  items.forEach(body => validateRequest(id, body));
  const results = [];
  for (const [index, item] of items.entries()) {
    try { results.push({ index, status: 'success', ...await executeAgent(req.user, id, item) }); }
    catch (e) { results.push({ index, status: 'failed', error: e.status && e.status < 500 ? e.message : '任务执行失败，请重试' }); }
  }
  res.json({ results, success: results.filter(r => r.status === 'success').length, total: items.length });
}));

// 执行历史（含结构化结果）
router.get('/agent-runs', asyncH(async (req, res) => {
  const t = requireTenant();
  const limit = Math.min(200, Math.max(1, Math.floor(Number(req.query.limit) || 50)));
  const offset = Math.max(0, Math.min(1000000, Math.floor(Number(req.query.offset) || 0)));
  let where = 'user_id=? AND tenant_id=?';
  const params = [req.user.id, t];
  if (req.query.agent_id) { where += ' AND agent_id=?'; params.push(String(req.query.agent_id)); }
  if (req.query.favorite === '1') where += ' AND favorite=1';
  if (req.query.q) { where += ' AND input LIKE ?'; params.push('%' + String(req.query.q).slice(0, 100) + '%'); }
  for (const key of ['date_start', 'date_end']) {
    if (!req.query[key]) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.query[key])) return res.status(400).json({ error: '日期格式不正确' });
    where += key === 'date_start' ? ' AND created_at >= ?' : ' AND created_at <= ?';
    params.push(String(req.query[key]) + (key === 'date_end' ? ' 23:59:59' : ''));
  }
  const runs = await repos.adapter.all(
    `SELECT id, agent_id, agent_name, input, result, result_parsed, source, tokens_est, duration_ms, created_at, favorite
     FROM agent_runs WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  const parsed = runs.map(r => {
    let structured = null;
    try { structured = r.result_parsed ? JSON.parse(r.result_parsed) : null; } catch (e) {}
    return { ...r, result_parsed: structured };
  });

  const count = await repos.adapter.get(`SELECT COUNT(*) count FROM agent_runs WHERE ${where}`, params);
  res.json({ runs: parsed, limit, offset, total: Number(count.count) });
}));

// 获取单次执行详情
router.get('/agent-runs/:id', asyncH(async (req, res) => {
  res.json(await readRun(req.user, req.params.id));
}));

router.patch('/agent-runs/:id', asyncH(async (req, res) => {
  if (typeof req.body?.favorite !== 'boolean') return res.status(400).json({ error: 'favorite 必须为布尔值' });
  await readRun(req.user, req.params.id);
  await repos.adapter.run('UPDATE agent_runs SET favorite=? WHERE id=? AND user_id=? AND tenant_id=?', [req.body.favorite ? 1 : 0, req.params.id, req.user.id, requireTenant()]);
  res.json({ ok: true, favorite: req.body.favorite });
}));

router.delete('/agent-runs/:id', asyncH(async (req, res) => {
  await readRun(req.user, req.params.id);
  await repos.adapter.run('DELETE FROM agent_runs WHERE id=? AND user_id=? AND tenant_id=?', [req.params.id, req.user.id, requireTenant()]);
  res.json({ ok: true });
}));

router.post('/agent-runs/:id/export', asyncH(async (req, res) => {
  const run = await readRun(req.user, req.params.id);
  const format = req.body?.format || 'json';
  if (!['json', 'txt', 'csv', 'xls'].includes(format)) return res.status(400).json({ error: '支持 JSON、TXT、CSV、Excel XML (.xls)' });
  const result = run.result_parsed || run.result;
  const rows = result && typeof result === 'object' ? Object.entries(result).map(([key, value]) => ({ key, value: typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value ?? '待补充') })) : [{ key: '正文', value: String(result || '') }];
  let content;
  if (format === 'json') content = JSON.stringify({ agent: run.agent_name, input: run.input, options: run.options, source: run.source, result }, null, 2);
  if (format === 'txt') content = `${run.agent_name}\n输入：${run.input}\n来源：${run.source}\n\n` + rows.map(r => r.key + '\n' + r.value).join('\n\n');
  if (format === 'csv') content = '\uFEFF' + require('../csv').toCsv(rows.map(r => ({ key: r.key, value: /^[=+\-@\t\r\n]/.test(r.value) ? "'" + r.value : r.value })), [{ key: 'key', label: '字段' }, { key: 'value', label: '内容' }]);
  if (format === 'xls') content = require('../xlsx').toSpreadsheetML('智能体结果', [{ key: 'key', label: '字段' }, { key: 'value', label: '内容' }], rows);
  res.json({ filename: `agent-${run.agent_id}-${run.id}.${format}`, content, mime: { json: 'application/json', txt: 'text/plain', csv: 'text/csv', xls: 'application/vnd.ms-excel' }[format] });
}));

module.exports = router;
