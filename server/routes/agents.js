// ===== 智能体路由（对接推理层） =====
const express = require('express');
const { repos } = require('../repositories');
const { requireTenant } = require('../repositories/tenant-context');
const { enforceAiQuota, enforceUsageQuota } = require('../quota');
const { authRequired, asyncH, requireRole } = require('../middleware');
const { runAgent } = require('../inference');
const { getAgentCatalog } = require('../agent-prompts');
const { getStats, getProviderInfo, aiEnabled } = require('../ai');
const { todayLocal, dateLocalOffset } = require('../util');
const { getWorkbench, validateRequest } = require('../agent-workbench');
const { executeAgent, readRun } = require('../agent-execution');
const { httpError, resolveShopIds, isAdmin } = require('../access');
const executionService = require('../execution-service');
const { dayPrefix } = require('../repositories/sql');

const router = express.Router();
router.use(authRequired);
const workflowExecutionLocks = new Map();

async function withWorkflowExecutionLock(key, fn) {
  const prior = workflowExecutionLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  workflowExecutionLocks.set(key, current);
  await prior;
  try { return await fn(); }
  finally {
    release();
    if (workflowExecutionLocks.get(key) === current) workflowExecutionLocks.delete(key);
  }
}

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

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function validateWorkflowDefinition(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, '工作流参数格式错误');
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 100) throw httpError(400, '工作流名称不能为空且不能超过 100 字符');
  if (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 1000)) throw httpError(400, '工作流说明不能超过 1000 字符');
  if (!Array.isArray(body.nodes) || body.nodes.length < 1 || body.nodes.length > 10) throw httpError(400, '工作流必须包含 1–10 个节点');
  const seen = new Set();
  const nodes = body.nodes.map((node, index) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw httpError(400, `第 ${index + 1} 个节点格式错误`);
    const key = typeof node.key === 'string' && node.key.trim() ? node.key.trim() : `node_${index + 1}`;
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(key) || seen.has(key)) throw httpError(400, `第 ${index + 1} 个节点标识不正确或重复`);
    seen.add(key);
    const nodeType = node.type || 'agent';
    if (!['agent', 'approval'].includes(nodeType)) throw httpError(400, `第 ${index + 1} 个节点类型不正确`);
    const agentId = nodeType === 'approval' ? '__approval__' : String(node.agentId || node.agent_id || '');
    if (nodeType === 'agent' && (!getWorkbench(agentId) || !getAgentCatalog()[agentId])) throw httpError(400, `第 ${index + 1} 个节点的智能体不存在`);
    if (nodeType === 'approval' && index !== body.nodes.length - 1) throw httpError(400, '审核节点目前必须放在工作流末尾');
    if (node.input !== undefined && (typeof node.input !== 'string' || node.input.length > 4000)) throw httpError(400, `第 ${index + 1} 个节点输入不正确`);
    if (node.extra !== undefined && (typeof node.extra !== 'string' || node.extra.length > 12000)) throw httpError(400, `第 ${index + 1} 个节点补充要求过长`);
    if (node.inputFrom !== undefined && !['workflow', 'previous'].includes(node.inputFrom)) throw httpError(400, `第 ${index + 1} 个节点输入来源不正确`);
    if (node.inputTemplate !== undefined && (typeof node.inputTemplate !== 'string' || node.inputTemplate.length > 4000)) throw httpError(400, `第 ${index + 1} 个节点输入模板过长`);
    if (node.options !== undefined && (!node.options || typeof node.options !== 'object' || Array.isArray(node.options) || JSON.stringify(node.options).length > 30000)) throw httpError(400, `第 ${index + 1} 个节点参数不正确`);
    return { key, type: nodeType, agentId, input: node.input || '', inputFrom: node.inputFrom || 'workflow', inputTemplate: node.inputTemplate || '', extra: node.extra || '', options: node.options || {} };
  });
  return { name, description: body.description || '', nodes };
}

async function getWorkflow(user, id) {
  const row = await repos.adapter.get('SELECT * FROM agent_workflows WHERE id=? AND user_id=? AND tenant_id=?', [id, user.id, requireTenant()]);
  if (!row) throw httpError(404, '工作流不存在或无权访问');
  return { ...row, definition: parseJson(row.definition_json, { nodes: [] }) };
}

router.get('/agent-workflows', asyncH(async (req, res) => {
  const rows = await repos.adapter.all(
    'SELECT id,name,description,status,definition_json,created_at,updated_at FROM agent_workflows WHERE user_id=? AND tenant_id=? ORDER BY id DESC',
    [req.user.id, requireTenant()]
  );
  res.json({ workflows: rows.map(row => ({ ...row, definition: parseJson(row.definition_json, { nodes: [] }) })) });
}));

router.post('/agent-workflows', asyncH(async (req, res) => {
  const definition = validateWorkflowDefinition(req.body);
  const info = await repos.adapter.run(
    'INSERT INTO agent_workflows (tenant_id,user_id,name,description,definition_json) VALUES (?,?,?,?,?)',
    [requireTenant(), req.user.id, definition.name, definition.description, JSON.stringify({ nodes: definition.nodes })]
  );
  const workflow = await getWorkflow(req.user, info.lastInsertRowid);
  res.status(201).json(workflow);
}));

router.get('/agent-workflows/:id', asyncH(async (req, res) => {
  res.json(await getWorkflow(req.user, req.params.id));
}));

async function executeWorkflow(user, workflow, payload) {
  const input = payload.input.trim();
  const baseExtra = (payload.extra || '').trim();
  const baseOptions = payload.options && typeof payload.options === 'object' && !Array.isArray(payload.options) ? payload.options : {};
  const t = requireTenant();
  const runInfo = await repos.adapter.run(
    'INSERT INTO agent_workflow_runs (tenant_id,user_id,workflow_id,status,input_json) VALUES (?,?,?,?,?)',
    [t, user.id, workflow.id, 'running', JSON.stringify({ input, extra: baseExtra, options: baseOptions, retryOf: payload.retryOf || null })]
  );
  const runId = runInfo.lastInsertRowid;
  let previous = null;
  const results = [];
  for (const [position, node] of workflow.definition.nodes.entries()) {
    await repos.adapter.run('UPDATE agent_workflow_runs SET current_node=? WHERE id=? AND user_id=? AND tenant_id=?', [node.key, runId, user.id, t]);
    const previousResult = previous ? JSON.stringify(previous.result || {}).slice(0, 10000) : '';
    let nodeInput = node.input || input;
    if (node.inputFrom === 'previous' && previous) nodeInput = previous.input || input;
    if (node.inputTemplate) {
      nodeInput = node.inputTemplate.replace(/\{\{workflow_input\}\}/g, input).replace(/\{\{previous_input\}\}/g, previous?.input || '').replace(/\{\{previous_overview\}\}/g, String(previous?.result?.overview || ''));
    }
    const inherited = previous ? `\n\n【上一步智能体结果，仅作待核验参考】\n${previousResult}` : '';
    const nodeExtra = [baseExtra, node.extra, inherited].filter(Boolean).join('\n').slice(0, 12000);
    const nodeOptions = { ...baseOptions, ...(node.options || {}) };
    if (previous?.runId) nodeOptions.parentRunId = previous.runId;
    const nodeInfo = await repos.adapter.run(
      'INSERT INTO agent_workflow_nodes (tenant_id,run_id,node_key,agent_id,position,status,input_json,node_type,source_run_id,started_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [t, runId, node.key, node.agentId, position, 'running', JSON.stringify({ input: nodeInput, extra: nodeExtra, options: nodeOptions }), node.type || 'agent', previous?.runId || null, new Date().toISOString()]
    );
    if (node.type === 'approval') {
      await repos.adapter.run('UPDATE agent_workflow_nodes SET status=?,review_status=?,result_json=? WHERE id=? AND run_id=? AND tenant_id=?', ['pending_review', 'pending', JSON.stringify({ nodes: results }), nodeInfo.lastInsertRowid, runId, t]);
      await repos.adapter.run('UPDATE agent_workflow_runs SET status=?,output_json=? WHERE id=? AND user_id=? AND tenant_id=?', ['pending_review', JSON.stringify({ nodes: results, approvalNode: node.key }), runId, user.id, t]);
      return { runId, workflowId: workflow.id, status: 'pending_review', approvalNode: node.key, nodes: results };
    }
    try {
      const result = await executeAgent(user, node.agentId, { input: nodeInput, extra: nodeExtra, options: nodeOptions });
      await repos.adapter.run('UPDATE agent_workflow_nodes SET status=?,result_json=?,source_run_id=?,finished_at=? WHERE id=? AND run_id=? AND tenant_id=?', ['success', JSON.stringify(result.result || {}), previous?.runId || null, new Date().toISOString(), nodeInfo.lastInsertRowid, runId, t]);
      results.push({ key: node.key, agentId: node.agentId, status: 'success', runId: result.runId, result: result.result });
      previous = result;
    } catch (e) {
      const message = e.status && e.status < 500 ? e.message : '节点执行失败，请重试';
      await repos.adapter.run('UPDATE agent_workflow_nodes SET status=?,error_message=?,finished_at=? WHERE id=? AND run_id=? AND tenant_id=?', ['failed', message, new Date().toISOString(), nodeInfo.lastInsertRowid, runId, t]);
      await repos.adapter.run('UPDATE agent_workflow_runs SET status=?,error_message=?,output_json=?,finished_at=? WHERE id=? AND user_id=? AND tenant_id=?', ['failed', message, JSON.stringify({ nodes: results }), new Date().toISOString(), runId, user.id, t]);
      return { runId, workflowId: workflow.id, status: 'failed', error: message, nodes: [...results, { key: node.key, agentId: node.agentId, status: 'failed', error: message }] };
    }
  }
  await repos.adapter.run('UPDATE agent_workflow_runs SET status=?,output_json=?,finished_at=? WHERE id=? AND user_id=? AND tenant_id=?', ['success', JSON.stringify({ nodes: results }), new Date().toISOString(), runId, user.id, t]);
  return { runId, workflowId: workflow.id, status: 'success', nodes: results };
}

router.post('/agent-workflows/:id/run', asyncH(async (req, res) => {
  const workflow = await getWorkflow(req.user, req.params.id);
  if (workflow.status !== 'active') throw httpError(400, '工作流已停用');
  if (typeof req.body?.input !== 'string' || !req.body.input.trim() || req.body.input.length > 4000) throw httpError(400, '请输入工作流分析对象，且不能超过 4000 字符');
  if (req.body.extra !== undefined && (typeof req.body.extra !== 'string' || req.body.extra.length > 12000)) throw httpError(400, '工作流补充要求不能超过 12000 字符');
  res.json(await executeWorkflow(req.user, workflow, req.body));
}));

router.get('/agent-workflow-runs/:id(\\d+)', asyncH(async (req, res) => {
  const t = requireTenant();
  const run = await repos.adapter.get(`SELECT * FROM agent_workflow_runs WHERE id=? AND tenant_id=?${isAdmin(req.user) ? '' : ' AND user_id=?'}`, isAdmin(req.user) ? [req.params.id, t] : [req.params.id, t, req.user.id]);
  if (!run) throw httpError(404, '工作流运行记录不存在或无权访问');
  const nodes = await repos.adapter.all('SELECT * FROM agent_workflow_nodes WHERE run_id=? AND tenant_id=? ORDER BY position', [run.id, t]);
  const safeNodes = nodes.map(node => ({ ...node, input: parseJson(node.input_json, {}), result: parseJson(node.result_json, {}) }));
  res.json({ ...run, input: parseJson(run.input_json, {}), output: parseJson(run.output_json, {}), nodes: safeNodes });
}));

router.get('/agent-workflow-runs/pending-review', requireRole('boss', 'admin'), asyncH(async (req, res) => {
  const rows = await repos.adapter.all(
    `SELECT r.id,r.user_id,r.workflow_id,r.status,r.current_node,r.started_at,w.name AS workflow_name,u.username AS owner_name
     FROM agent_workflow_runs r
     JOIN agent_workflows w ON w.id=r.workflow_id AND w.tenant_id=r.tenant_id
     LEFT JOIN users u ON u.id=r.user_id AND u.tenant_id=r.tenant_id
     WHERE r.tenant_id=? AND r.status='pending_review' AND r.user_id<>?
     ORDER BY r.started_at ASC LIMIT 100`,
    [requireTenant(), req.user.id]
  );
  res.json({ runs: rows });
}));

router.post('/agent-workflow-runs/:id/retry', asyncH(async (req, res) => {
  const t = requireTenant();
  const run = await repos.adapter.get('SELECT * FROM agent_workflow_runs WHERE id=? AND user_id=? AND tenant_id=?', [req.params.id, req.user.id, t]);
  if (!run) throw httpError(404, '工作流运行记录不存在或无权访问');
  if (run.status !== 'failed') throw httpError(400, '只有失败的工作流才能重试');
  const workflow = await getWorkflow(req.user, run.workflow_id);
  const payload = parseJson(run.input_json, {});
  res.json(await executeWorkflow(req.user, workflow, { ...payload, retryOf: run.id }));
}));

router.post('/agent-workflow-runs/:id/review', requireRole('boss', 'admin'), asyncH(async (req, res) => {
  const t = requireTenant();
  const action = req.body?.action;
  if (!['approved', 'rejected'].includes(action)) throw httpError(400, '审核动作必须为 approved 或 rejected');
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 2000) : '';
  const run = await repos.adapter.get('SELECT * FROM agent_workflow_runs WHERE id=? AND tenant_id=?', [req.params.id, t]);
  if (!run) throw httpError(404, '工作流运行记录不存在或无权访问');
  if (Number(run.user_id) === Number(req.user.id)) throw httpError(403, '审核人不能审核自己发起的工作流');
  if (run.status !== 'pending_review') throw httpError(400, '当前工作流不在待审核状态');
  const node = await repos.adapter.get('SELECT * FROM agent_workflow_nodes WHERE run_id=? AND tenant_id=? AND node_type=? AND review_status=?', [run.id, t, 'approval', 'pending']);
  if (!node) throw httpError(400, '未找到待审核节点');
  const nextStatus = action === 'approved' ? 'success' : 'rejected';
  await repos.adapter.tx(async () => {
    const reviewedAt = new Date().toISOString();
    const updatedNode = await repos.adapter.run('UPDATE agent_workflow_nodes SET status=?,review_status=?,reviewed_by=?,reviewed_at=?,review_note=?,finished_at=? WHERE id=? AND run_id=? AND tenant_id=? AND review_status=?', [nextStatus, action, req.user.id, reviewedAt, note, reviewedAt, node.id, run.id, t, 'pending']);
    if (!updatedNode.changes) throw httpError(409, '该审核节点已被其他管理员处理');
    const updatedRun = await repos.adapter.run('UPDATE agent_workflow_runs SET status=?,error_message=?,finished_at=? WHERE id=? AND status=? AND tenant_id=?', [nextStatus, action === 'rejected' ? (note || '审核驳回') : null, reviewedAt, run.id, 'pending_review', t]);
    if (!updatedRun.changes) throw httpError(409, '该工作流已被其他管理员处理');
    await repos.adapter.run('INSERT INTO audit_logs (tenant_id,user_id,action,target_type,target_id,detail_json) VALUES (?,?,?,?,?,?)',
      [t, req.user.id, 'agent_workflow_review', 'agent_workflow_run', String(run.id), JSON.stringify({ action, ownerId: run.user_id, note })]);
  });
  res.json({ ok: true, runId: run.id, status: nextStatus, review: { action, note, reviewedBy: req.user.id } });
}));

function validateWorkflowExecutionActions(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.actions) || body.actions.length < 1 || body.actions.length > 50) {
    throw httpError(400, 'actions 必须为 1–50 条执行动作');
  }
  const allowed = new Set(['adjust_price', 'pause', 'add_budget']);
  return body.actions.map((action, index) => {
    if (!action || typeof action !== 'object' || Array.isArray(action)) throw httpError(400, `第 ${index + 1} 条执行动作格式错误`);
    const shopId = Number(action.shopId ?? action.shop_id);
    if (!Number.isSafeInteger(shopId) || shopId <= 0) throw httpError(400, `第 ${index + 1} 条动作的店铺 ID 不正确`);
    const actionType = String(action.actionType ?? action.action_type ?? '');
    if (!allowed.has(actionType)) throw httpError(400, `第 ${index + 1} 条动作类型不支持`);
    const campaignId = String(action.campaignId ?? action.campaign_id ?? '').trim();
    if (!campaignId || campaignId.length > 200) throw httpError(400, `第 ${index + 1} 条动作缺少有效计划 ID`);
    const reason = String(action.reason || '').trim().slice(0, 500);
    if (!reason) throw httpError(400, `第 ${index + 1} 条动作必须填写原因`);
    const numberOrNull = (value, label) => {
      if (value === undefined || value === null || value === '') return null;
      const n = Number(value);
      if (!Number.isFinite(n) || Math.abs(n) > 1000000000) throw httpError(400, `第 ${index + 1} 条动作的${label}不正确`);
      return n;
    };
    const currentValue = numberOrNull(action.currentValue ?? action.current_value, '当前值');
    const suggestedValue = numberOrNull(action.suggestedValue ?? action.suggested_value, '目标值');
    if (actionType === 'adjust_price' && (!(currentValue > 0) || !(suggestedValue > 0))) throw httpError(400, `第 ${index + 1} 条调价动作必须提供正数当前值和目标值`);
    if (actionType === 'add_budget' && !(suggestedValue > 0)) throw httpError(400, `第 ${index + 1} 条加预算动作必须提供正数目标值`);
    const nodeKey = typeof action.nodeKey === 'string' ? action.nodeKey.trim() : '';
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(nodeKey)) throw httpError(400, `第 ${index + 1} 条动作的推广分析来源节点不正确`);
    return { shopId, actionType, campaignId, currentValue, suggestedValue, reason, nodeKey };
  });
}

function promotionCampaigns(result) {
  const values = new Set();
  const add = value => { if (typeof value === 'string' && value.trim()) values.add(value.trim()); };
  for (const key of ['loss_campaigns', 'efficient_campaigns', 'campaign_status', 'adjustments']) {
    const rows = Array.isArray(result?.[key]) ? result[key] : [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      add(row.campaign_id); add(row.campaignId); add(row.campaign); add(row.plan_id); add(row.planId); add(row.plan);
    }
  }
  for (const row of Array.isArray(result?.budget_reallocation) ? result.budget_reallocation : []) {
    if (!row || typeof row !== 'object') continue;
    add(row.from); add(row.to); add(row.campaign_id); add(row.campaignId);
  }
  return values;
}

// 审核通过后生成执行任务：动作必须由管理员明确提交，智能体结果本身不直接触发执行。
router.post('/agent-workflow-runs/:id/execution-drafts', requireRole('boss', 'admin'), asyncH(async (req, res) => {
  const t = requireTenant();
  const run = await repos.adapter.get('SELECT * FROM agent_workflow_runs WHERE id=? AND tenant_id=?', [req.params.id, t]);
  if (!run) throw httpError(404, '工作流运行记录不存在或无权访问');
  if (run.status !== 'success') throw httpError(400, '只有审核通过且成功的工作流才能生成执行任务');
  if (Number(run.user_id) === Number(req.user.id)) throw httpError(403, '执行任务创建人不能与工作流发起人相同');
  const approval = await repos.adapter.get("SELECT * FROM agent_workflow_nodes WHERE run_id=? AND tenant_id=? AND node_type='approval' AND review_status='approved'", [run.id, t]);
  if (!approval || Number(approval.reviewed_by) === Number(run.user_id)) throw httpError(400, '该工作流没有有效的独立审核通过记录');
  const existingBatch = await repos.adapter.get('SELECT id FROM agent_workflow_execution_batches WHERE tenant_id=? AND workflow_run_id=?', [t, run.id]);
  if (existingBatch) throw httpError(409, '该工作流运行已生成过执行任务，不能重复创建');
  const runNodes = await repos.adapter.all("SELECT * FROM agent_workflow_nodes WHERE run_id=? AND tenant_id=? AND status='success' AND agent_id IN ('a13','a14') ORDER BY position", [run.id, t]);
  if (!runNodes.length) throw httpError(400, '只有包含推广分析或万相台分析节点的工作流可以生成推广执行任务');
  const eligibleNodes = new Map(runNodes.map(node => [node.node_key, { ...node, candidates: promotionCampaigns(parseJson(node.result_json, {})) }]));
  const actions = validateWorkflowExecutionActions(req.body);
  await resolveShopIds(req.user, [...new Set(actions.map(action => action.shopId))]);
  for (const action of actions) {
    const node = eligibleNodes.get(action.nodeKey);
    if (!node) throw httpError(400, `来源节点 ${action.nodeKey} 不是本次运行中成功的推广分析节点`);
    const campaign = await repos.adapter.get('SELECT * FROM ad_campaigns WHERE tenant_id=? AND shop_id=? AND (campaign_id=? OR campaign_name=?) ORDER BY report_date DESC LIMIT 1', [t, action.shopId, action.campaignId, action.campaignId]);
    if (!campaign) throw httpError(400, `店铺 ${action.shopId} 中找不到推广计划 ${action.campaignId}`);
    if (!node.candidates.has(String(campaign.campaign_id)) && !node.candidates.has(String(campaign.campaign_name))) {
      throw httpError(400, `推广计划 ${campaign.campaign_name} 未出现在来源分析节点的候选结果中`);
    }
    if (action.actionType === 'adjust_price') {
      const actualCurrent = Number(campaign.cpc);
      if (!Number.isFinite(actualCurrent) || Math.abs(actualCurrent - action.currentValue) > 0.000001) {
        throw httpError(400, `计划 ${campaign.campaign_name} 的当前 CPC 已变化，请刷新数据后重新确认`);
      }
    }
    action.campaignId = campaign.campaign_id;
    action.campaignName = campaign.campaign_name;
  }

  const shops = new Map();
  for (const shopId of new Set(actions.map(action => action.shopId))) {
    const shop = await repos.adapter.get('SELECT * FROM shops WHERE id=? AND tenant_id=?', [shopId, t]);
    if (!shop) throw httpError(404, `店铺 ${shopId} 不存在`);
    shops.set(shopId, shop);
  }

  const pendingCounts = new Map();
  const today = todayLocal();
  for (const action of actions) {
    const shop = shops.get(action.shopId);
    const currentCount = pendingCounts.get(action.shopId) || Number((await repos.adapter.get(
      "SELECT COUNT(*) c FROM executions WHERE tenant_id=? AND shop_id=? AND status IN ('queued','running','success','pending_manual') AND created_at LIKE ?",
      [t, action.shopId, dayPrefix(today)]
    ))?.c || 0);
    if (currentCount >= Number(shop.daily_adjust_limit || 5)) throw httpError(400, `店铺 ${shop.shop_name} 今日执行任务已达到上限`);
    pendingCounts.set(action.shopId, currentCount + 1);
    if (action.actionType === 'adjust_price') {
      const ratio = Math.abs(action.suggestedValue - action.currentValue) / action.currentValue;
      if (ratio > executionService.MAX_ADJUST_RATIO) throw httpError(400, `计划 ${action.campaignId} 调价幅度超过上限 ${executionService.MAX_ADJUST_RATIO * 100}%`);
    }
  }

  let created;
  try {
    created = await withWorkflowExecutionLock(`${t}:${run.id}`, async () => {
      const racedBatch = await repos.adapter.get('SELECT id FROM agent_workflow_execution_batches WHERE tenant_id=? AND workflow_run_id=?', [t, run.id]);
      if (racedBatch) throw httpError(409, '该工作流运行已生成过执行任务，不能重复创建');
      return repos.adapter.tx(async () => {
        const batchInfo = await repos.adapter.run('INSERT INTO agent_workflow_execution_batches (tenant_id,workflow_run_id,created_by,actions_json) VALUES (?,?,?,?)', [t, run.id, req.user.id, JSON.stringify(actions)]);
        const rows = [];
        for (const action of actions) {
          const suggestionItem = { id: null, shop_id: action.shopId, action_type: action.actionType, campaign_id: action.campaignId, current_value: action.currentValue, suggested_value: action.suggestedValue, reason: `工作流运行 #${run.id}：${action.reason}` };
          const result = await executionService.createExecution({ suggestionItem, shop: shops.get(action.shopId), userId: req.user.id, workflowRunId: run.id, workflowNodeKey: action.nodeKey });
          const execution = await repos.adapter.get('SELECT * FROM executions WHERE id=? AND tenant_id=?', [result.id, t]);
          rows.push({ ...execution, executor: result.auto ? 'rpa' : 'manual' });
        }
        await repos.adapter.run('INSERT INTO audit_logs (tenant_id,user_id,action,target_type,target_id,detail_json) VALUES (?,?,?,?,?,?)',
          [t, req.user.id, 'agent_workflow_execution_create', 'agent_workflow_run', String(run.id), JSON.stringify({ batchId: batchInfo.lastInsertRowid, count: rows.length, executionIds: rows.map(item => item.id) })]);
        return { batchId: batchInfo.lastInsertRowid, rows };
      });
    });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.code === '23505' || /unique constraint/i.test(error.message || '')) throw httpError(409, '该工作流运行已生成过执行任务，不能重复创建');
    throw error;
  }
  res.status(201).json({ workflowRunId: run.id, batchId: created.batchId, executions: created.rows, auto: executionService.autoConfig().enabled });
}));

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
