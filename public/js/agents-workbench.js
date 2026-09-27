// 原生 JS 工作台，复用现有 API/state；草稿仅在当前登录会话内存保留。
const agentStudio = { epoch: 0, busy: false, user: '', drafts: {}, run: null, historyPage: 0, uploads: 0, parentRunId: null };
const agentWorkflowRuns = new Map();
const agentLabels = {
  overview: '结果概览', opportunities: '市场机会', products: '选款排序', issues: '问题诊断', themes: '评价主题', keywords: '关键词', titles: '标题方案', copies: '文案版本', plans: '主图方案',
  suggestions: '下一步建议', missing_data: '待补充数据', warnings: '使用提示', evidence: '依据', expected: '效果与验证', findings: '核心发现',
  keyword: '关键词', intent: '搜索意图', category: '分类', volume: '搜索量', trend: '趋势', priority: '优先级', use: '适用位置',
  name: '商品', classification: '选款分类', profit_rate: '毛利率 (%)', score: '评分', risk: '风险', action: '建议动作',
  health_score: '健康评分', dimension: '诊断维度', issue: '问题', severity: '程度', validation: '验证方式',
  sample_count: '评价样本行数', selling_points: '用户认可点', pain_points: '用户痛点', sentiment: '情绪', count: '匹配行数',
  competition: '竞争程度', opportunity_score: '机会评分', audience: '目标人群', price_range: '价格区间',
  title: '标题', content: '正文', platform: '平台', tone: '风格', angle: '创作方向', word_count: '字符数', checks: '内容检查', keyword_coverage: '已覆盖关键词', rationale: '创作说明',
  objective: '画面目标', composition: '构图', palette: '配色', copy: '图中文字', scene: '使用场景', prompt: '图片提示词', raw_text: '原始回复', data_source: '依据来源', market_size: '市场规模', image_status: '图片状态'
};
function agentEscape(value) { return String(value ?? '').replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s])); }
function agentToast(message, type) { showToast(agentEscape(message), type); }
function agentItems() { return (state.agents || []).flatMap(g => g.items); }
function agentResetSession() {
  const key = localStorage.getItem('zy_token') || '';
  if (agentStudio.user !== key) { agentStudio.user = key; agentStudio.drafts = {}; agentStudio.run = null; agentStudio.epoch++; }
}
async function loadAgents() {
  agentResetSession();
  try { const data = await API.get('/agents'); state.agents = data.agents; renderAgentTabs(); renderAgentGrid(state.agentCategory); }
  catch (e) { $('agent-grid').innerHTML = `<div class="agent-note error">${agentEscape(e.message)} <button class="btn btn-outline" onclick="loadAgents()">重试</button></div>`; }
}
function toggleAgentWorkflowPanel() {
  const panel = $('agent-workflow-panel');
  if (!panel) return;
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  if (panel.style.display === 'block') loadAgentWorkflows();
}
async function loadAgentWorkflows() {
  const panel = $('agent-workflow-panel'); if (!panel) return;
  panel.innerHTML = '<div class="agent-note">正在加载工作流…</div>';
  try {
    const data = await API.get('/agent-workflows');
    const rows = (data.workflows || []).map(w => {
      const nodes = w.definition?.nodes || [];
      return `<div class="agent-output-card" style="margin-top:10px;"><div class="flex-between"><strong>${agentEscape(w.name)}</strong><span class="agent-pill">${nodes.length} 个节点</span></div><div class="agent-field-help">${agentEscape(w.description || '')}</div><div class="agent-field-help">${nodes.map(n => agentEscape(n.type === 'approval' ? '人工审核' : n.agentId)).join(' → ')}</div><div class="agent-output-actions"><button class="btn btn-primary btn-sm" onclick="runAgentWorkflow(${Number(w.id)})">运行</button></div></div>`;
    }).join('');
    const reviewer = agentCurrentUser();
    let reviewQueue = '';
    if (reviewer && ['boss', 'admin'].includes(reviewer.role)) {
      const queue = await API.get('/agent-workflow-runs/pending-review');
      reviewQueue = `<div class="agent-section-title">待审核工作流</div>${(queue.runs || []).map(run => `<div class="agent-output-card"><strong>${agentEscape(run.workflow_name)} · 运行 #${Number(run.id)}</strong><div class="agent-field-help">发起人：${agentEscape(run.owner_name || run.user_id)} · ${agentEscape(run.current_node || '待审核')}</div><button class="btn btn-outline btn-sm" onclick="showAgentWorkflowRun(${Number(run.id)})">查看并审核</button></div>`).join('') || '<div class="agent-note">暂无待审核工作流</div>'}`;
    }
    panel.innerHTML = `<div class="flex-between"><div><div class="card-title">智能体工作流</div><div class="agent-field-help">按顺序运行多个智能体，节点结果会自动传给下一步。</div></div><button class="btn btn-outline btn-sm" onclick="showAgentWorkflowCreate()">新建工作流</button></div>${reviewQueue}<div id="agent-workflow-create"></div>${rows || '<div class="agent-note">暂无工作流，请先新建一个。</div>'}`;
  } catch (e) { panel.innerHTML = `<div class="agent-note error">${agentEscape(e.message)}</div>`; }
}
function showAgentWorkflowCreate() {
  const el = $('agent-workflow-create'); if (!el) return;
  el.innerHTML = `<div class="agent-output-card" style="margin-top:12px;"><div class="form-group"><label class="form-label">工作流名称</label><input id="agent-wf-name" class="form-input" maxlength="100" placeholder="例如：选品到标题"></div><div class="form-group"><label class="form-label">智能体顺序</label><input id="agent-wf-agents" class="form-input" maxlength="200" placeholder="例如：a1,a6,a2,a7"><div class="agent-field-help">请使用智能体 ID，用逗号分隔；可在智能体卡片或目录中查看 ID。</div></div><div class="form-group"><label class="form-label">说明</label><input id="agent-wf-desc" class="form-input" maxlength="1000" placeholder="这个工作流解决什么问题"></div><button class="btn btn-primary btn-sm" onclick="createAgentWorkflow()">保存工作流</button></div>`;
}
async function createAgentWorkflow() {
  const name = $('agent-wf-name')?.value.trim(), ids = ($('agent-wf-agents')?.value || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!name || !ids.length) return agentToast('请填写名称和至少一个智能体 ID', 'warn');
  try {
    await API.post('/agent-workflows', { name, description: $('agent-wf-desc')?.value.trim() || '', nodes: ids.map((agentId, i) => agentId.toLowerCase() === 'approval' ? ({ key: `node_${i + 1}`, type: 'approval' }) : ({ key: `node_${i + 1}`, agentId })) });
    agentToast('工作流已保存', 'success'); loadAgentWorkflows();
  } catch (e) { agentToast(e.message, 'error'); }
}
async function runAgentWorkflow(id) {
  const input = window.prompt('请输入本次工作流的商品或分析对象');
  if (!input || !input.trim()) return;
  try {
    const data = await API.post('/agent-workflows/' + id + '/run', { input: input.trim() });
    if (data.status === 'success') { agentToast(`工作流完成，共 ${data.nodes.length} 个节点`, 'success'); showAgentWorkflowRun(data.runId); }
    else if (data.status === 'pending_review') { agentToast('工作流已暂停，等待人工审核', 'warn'); showAgentWorkflowRun(data.runId); }
    else { agentToast(data.error || '工作流执行失败', 'error'); if (data.runId) showAgentWorkflowRun(data.runId); }
    loadAgentWorkflows();
  } catch (e) { agentToast(e.message, 'error'); }
}
async function showAgentWorkflowRun(runId) {
  try {
    const run = await API.get('/agent-workflow-runs/' + runId);
    agentWorkflowRuns.set(Number(runId), run);
    const nodes = (run.nodes || []).map(n => `<div class="agent-output-card" style="margin-top:8px;"><strong>${agentEscape(n.node_key)} · ${agentEscape(n.agent_id)}</strong><div class="agent-field-help">状态：${agentEscape(n.status)}${n.error_message ? ' · ' + agentEscape(n.error_message) : ''}</div><pre style="white-space:pre-wrap;max-height:220px;overflow:auto;font-size:11px;">${agentEscape(JSON.stringify(n.result || {}, null, 2))}</pre></div>`).join('');
    const retry = run.status === 'failed' ? `<button class="btn btn-primary btn-sm" onclick="retryAgentWorkflow(${Number(run.id)})">重试工作流</button>` : '';
    const reviewer = agentCurrentUser(), isReviewer = reviewer && ['boss', 'admin'].includes(reviewer.role) && Number(run.user_id) !== Number(reviewer.id);
    const review = run.status === 'pending_review' && isReviewer ? `<button class="btn btn-success btn-sm" onclick="reviewAgentWorkflow(${Number(run.id)},'approved')">审核通过</button> <button class="btn btn-outline btn-sm" onclick="reviewAgentWorkflow(${Number(run.id)},'rejected')">驳回</button>` : '';
    const hasIndependentApproval = (run.nodes || []).some(n => n.node_type === 'approval' && n.review_status === 'approved' && Number(n.reviewed_by) !== Number(run.user_id));
    const execute = run.status === 'success' && isReviewer && hasIndependentApproval ? `<button class="btn btn-primary btn-sm" onclick="showAgentWorkflowExecutionForm(${Number(run.id)})">预览并生成执行任务</button>` : '';
    const gateHint = run.status === 'success' && !hasIndependentApproval ? '<div class="agent-field-help">生成执行任务需要独立管理员审核。</div>' : '';
    openGenericModal(`工作流运行 #${Number(run.id)}`, `<div class="agent-note">状态：${agentEscape(run.status)} ${retry} ${review} ${execute}</div>${gateHint}<div id="agent-wf-execution-form"></div>${nodes || '<div class="agent-note">暂无节点记录</div>'}`);
  } catch (e) { agentToast(e.message, 'error'); }
}
async function retryAgentWorkflow(runId) {
  try { const data = await API.post('/agent-workflow-runs/' + runId + '/retry', {}); closeModal('modal-generic'); agentToast(data.status === 'success' ? '工作流重试完成' : (data.error || '重试失败'), data.status === 'success' ? 'success' : 'error'); if (data.runId) showAgentWorkflowRun(data.runId); } catch (e) { agentToast(e.message, 'error'); }
}
async function reviewAgentWorkflow(runId, action) {
  const note = window.prompt(action === 'approved' ? '审核备注（可选）' : '请输入驳回原因') || '';
  if (action === 'rejected' && !note.trim()) return agentToast('驳回时必须填写原因', 'warn');
  try { const data = await API.post('/agent-workflow-runs/' + runId + '/review', { action, note }); closeModal('modal-generic'); agentToast(data.status === 'success' ? '审核通过，工作流已完成' : '工作流已驳回', data.status === 'success' ? 'success' : 'warn'); showAgentWorkflowRun(runId); } catch (e) { agentToast(e.message, 'error'); }
}
function agentCurrentUser() { try { return JSON.parse(localStorage.getItem('zy_user') || 'null'); } catch { return null; } }
function workflowPromotionCandidates(run) {
  const candidates = new Map();
  for (const node of run?.nodes || []) {
    if (node.status !== 'success' || !['a13', 'a14'].includes(node.agent_id)) continue;
    for (const key of ['loss_campaigns', 'efficient_campaigns', 'campaign_status', 'adjustments', 'budget_reallocation']) {
      const rows = Array.isArray(node.result?.[key]) ? node.result[key] : [];
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const vals = key === 'budget_reallocation' ? [row.from, row.to, row.campaign_id, row.campaignId] : [row.campaign_id, row.campaignId, row.campaign, row.plan_id, row.planId, row.plan];
        for (const val of vals) if (typeof val === 'string' && val.trim()) candidates.set(`${node.node_key}\n${val.trim()}`, { nodeKey: node.node_key, campaign: val.trim() });
      }
    }
  }
  return [...candidates.values()];
}
async function showAgentWorkflowExecutionForm(runId) {
  const host = $('agent-wf-execution-form'), run = agentWorkflowRuns.get(Number(runId)); if (!host || !run) return;
  const candidates = workflowPromotionCandidates(run);
  if (!candidates.length) { host.innerHTML = '<div class="agent-note warning">分析结果没有可核验的推广计划候选项，不能生成执行任务。</div>'; return; }
  let shops = [];
  try { shops = (await API.get('/shops')).shops || []; } catch (e) { host.innerHTML = `<div class="agent-note error">${agentEscape(e.message)}</div>`; return; }
  if (!shops.length) { host.innerHTML = '<div class="agent-note warning">当前账号没有可操作的店铺。</div>'; return; }
  host.innerHTML = `<div class="agent-output-card" style="margin:10px 0"><strong>推广动作预览</strong><div class="agent-field-help">只列出分析节点给出的计划候选。逐项选择店铺、动作并核实数值，提交后会进入现有执行中心。</div>${candidates.map((item, i) => `<div class="agent-output-card" style="margin-top:8px"><label><input type="checkbox" id="wf-exec-on-${i}" checked> ${agentEscape(item.campaign)}</label><div class="agent-field-help">来源节点：${agentEscape(item.nodeKey)}</div><div class="agent-form-fields"><div class="form-group"><label class="form-label">店铺</label><select class="form-select" id="wf-exec-shop-${i}">${shops.map(s => `<option value="${Number(s.id)}">${agentEscape(s.shop_name)}</option>`).join('')}</select></div><div class="form-group"><label class="form-label">动作</label><select class="form-select" id="wf-exec-action-${i}"><option value="pause">暂停计划</option><option value="adjust_price">调整出价</option><option value="add_budget">增加预算</option></select></div><div class="form-group"><label class="form-label">当前值（调价必填）</label><input class="form-input" id="wf-exec-current-${i}" type="number" min="0.000001" step="0.01"></div><div class="form-group"><label class="form-label">目标值（调价 / 加预算必填）</label><input class="form-input" id="wf-exec-target-${i}" type="number" min="0.000001" step="0.01"></div></div><div class="form-group"><label class="form-label">执行原因</label><input class="form-input" id="wf-exec-reason-${i}" maxlength="500" placeholder="填写人工核验后的原因"></div></div>`).join('')}<button class="btn btn-primary btn-sm" onclick="submitAgentWorkflowExecutions(${Number(runId)},${candidates.length})">确认生成执行任务</button> <button class="btn btn-outline btn-sm" onclick="showAgentWorkflowRun(${Number(runId)})">返回结果</button></div>`;
}
async function submitAgentWorkflowExecutions(runId, count) {
  const run = agentWorkflowRuns.get(Number(runId)), candidates = workflowPromotionCandidates(run), actions = [];
  for (let i = 0; i < count; i++) {
    if (!$(`wf-exec-on-${i}`)?.checked) continue;
    const actionType = $(`wf-exec-action-${i}`).value, currentValue = $(`wf-exec-current-${i}`).value, suggestedValue = $(`wf-exec-target-${i}`).value;
    if (!($(`wf-exec-reason-${i}`).value || '').trim()) return agentToast('每条动作都要填写核验原因', 'warn');
    if (actionType === 'adjust_price' && (!currentValue || !suggestedValue)) return agentToast('调价动作需要填写当前值和目标值', 'warn');
    if (actionType === 'add_budget' && !suggestedValue) return agentToast('增加预算需要填写目标值', 'warn');
    actions.push({ shopId: Number($(`wf-exec-shop-${i}`).value), actionType, campaignId: candidates[i].campaign, nodeKey: candidates[i].nodeKey, reason: $(`wf-exec-reason-${i}`).value.trim(), ...(currentValue ? { currentValue: Number(currentValue) } : {}), ...(suggestedValue ? { suggestedValue: Number(suggestedValue) } : {}) });
  }
  if (!actions.length) return agentToast('至少选择一条推广动作', 'warn');
  try { const data = await API.post('/agent-workflow-runs/' + runId + '/execution-drafts', { actions }); closeModal('modal-generic'); agentToast(`已生成 ${data.executions?.length || 0} 条执行任务，请到执行中心继续处理`, 'success'); showAgentWorkflowRun(runId); } catch (e) { agentToast(e.message, 'error'); }
}
function renderAgentTabs() {
  $('agent-tabs').innerHTML = ['全部', ...state.agents.map(g => g.cat)].map((c, i) => `<button class="filter-btn ${state.agentCategory === c ? 'active' : ''}" onclick="filterAgents(this,${i})">${agentEscape(c)}</button>`).join('');
}
function filterAgents(btn, index) { state.agentCategory = ['全部', ...state.agents.map(g => g.cat)][index] || '全部'; renderAgentTabs(); renderAgentGrid(state.agentCategory); }
function renderAgentGrid(cat = '全部') {
  const search = ($('agent-search')?.value || '').trim().toLowerCase(), coreOnly = $('agent-scope')?.value !== 'all';
  const items = state.agents.filter(g => cat === '全部' || g.cat === cat).flatMap(g => g.items).filter(a => (!coreOnly || a.workbench) && `${a.name} ${a.desc} ${(a.tags || []).join(' ')}`.toLowerCase().includes(search));
  items.sort((a, b) => a.id === 'a17' ? -1 : b.id === 'a17' ? 1 : 0);
  $('agent-market-count').textContent = `${items.length} 个智能体 · ${coreOnly ? '专业工作台' : '全部能力'}`;
  $('agent-grid').innerHTML = items.map(a => `<button type="button" class="agent-card ${a.workbench ? 'core-agent' : ''}" onclick="openAgent('${a.id}')"><div class="agent-card-top"><div class="agent-icon" style="background:${agentEscape(a.color)}">${agentEscape(a.icon)}</div><span class="agent-pill">${agentEscape(a.workbench?.label || a.tags?.[0] || '智能助手')}</span></div><div class="agent-name">${agentEscape(a.name)} <span class="agent-field-help">${agentEscape(a.id)}</span></div><div class="agent-desc">${agentEscape(a.desc)}</div><div class="agent-card-footer"><span>${a.workbench?.type === 'image' ? '方案 / 图片' : ['copy', 'title', 'plan'].includes(a.workbench?.type) ? '多版本创作' : '数据与依据'}</span><span>进入工作台 ↗</span></div></button>`).join('') || '<div class="agent-note">没有匹配的智能体，试试其他关键词或切换到全部智能体。</div>';
}
function agentFields(agent) { return agent.workbench?.fields || [{ key: 'period', label: '分析周期', type: 'select', choices: ['近7天', '近30天', '近90天'], default: '近30天' }]; }
function agentImagePreview(url) { return /^\/uploads\/[a-zA-Z0-9_./?=%-]+$/.test(url || '') ? `<img class="agent-image-preview" src="${agentEscape(__apiUrl(url))}" alt="商品参考图"><button type="button" class="btn btn-outline btn-sm" onclick="document.getElementById('af-referenceImage').value='';document.getElementById('agent-image-preview').innerHTML=''">移除</button>` : ''; }
function agentFormField(f, value) {
  const a = agentEscape, id = 'af-' + f.key, chosen = value ?? f.default ?? '';
  let control;
  if (f.type === 'select') control = `<select id="${id}" class="form-select">${f.choices.map(v => `<option ${chosen === v ? 'selected' : ''} value="${a(v)}">${a(v)}</option>`).join('')}</select>`;
  else if (f.type === 'shops') control = `<select id="${id}" class="form-select" multiple size="4" aria-label="${a(f.label)}"></select><div class="agent-field-help">未选择时使用全部有权限的店铺；可按住 Ctrl / Command 多选。</div>`;
  else if (f.type === 'textarea') control = `<textarea id="${id}" class="form-textarea" maxlength="${f.maxLength}" placeholder="${a(f.placeholder)}">${a(chosen)}</textarea>`;
  else if (f.type === 'image') control = `<input id="${id}" type="hidden" value="${a(chosen)}"><input type="file" id="agent-image-file" class="agent-upload" accept="image/png,image/jpeg,image/webp" onchange="agentUploadImage(this)"><div id="agent-image-preview">${agentImagePreview(chosen)}</div>`;
  else control = `<input id="${id}" class="form-input" type="${f.type === 'number' ? 'number' : 'text'}" value="${a(chosen)}" ${f.type === 'number' ? `min="${f.min}" max="${f.max}" step="1" required` : `maxlength="${f.maxLength || 2000}"`} placeholder="${a(f.placeholder || '')}">`;
  const importable = ['dataText', 'reviews', 'questions', 'keywords', 'competitorData', 'taxData', 'regionData', 'promotionData', 'plan'].includes(f.key);
  return `<div class="form-group ${['textarea', 'image', 'shops'].includes(f.type) ? 'wide' : ''}"><label class="form-label" for="${id}">${a(f.label)}</label>${control}${importable ? `<input class="agent-upload" type="file" accept=".csv,.txt" aria-label="导入${a(f.label)}" onchange="agentImportText(this,'${f.key}',${f.maxLength})"><div class="agent-field-help">可粘贴 Excel 表格，或导入 UTF-8 CSV / TXT，最多 ${f.maxLength} 字符。</div>` : ''}</div>`;
}
function agentCollect() {
  const options = {};
  for (const f of agentFields(state.currentAgent)) {
    if (f.type === 'shops') {
      const v = [...document.querySelectorAll('#af-' + f.key + ' option:checked')].map(o => Number(o.value));
      if (v.length) options[f.key] = v;
      continue;
    }
    const v = $('af-' + f.key)?.value || ''; if (v !== '') options[f.key] = f.type === 'number' ? Number(v) : v.trim();
  }
  if (agentStudio.parentRunId) options.parentRunId = Number(agentStudio.parentRunId);
  return { input: $('agent-input-1')?.value.trim() || '', extra: $('agent-extra')?.value.trim() || '', options };
}
async function agentFillShopField(selectedIds = []) {
  const sel = $('af-shopIds'); if (!sel) return;
  try {
    const data = await API.get('/shops');
    const shops = data.shops || [], selected = new Set((selectedIds || []).map(Number));
    const hasExplicit = selected.size > 0;
    sel.innerHTML = shops.map(s => `<option value="${Number(s.id)}"${hasExplicit ? (selected.has(Number(s.id)) ? ' selected' : '') : ' selected'}>${agentEscape(s.shop_name)} · ${agentEscape(s.platform || '')}</option>`).join('');
  } catch (_) { sel.innerHTML = '<option disabled>店铺列表暂时不可用</option>'; }
}
function agentSaveDraft() { if (state.currentAgent && $('agent-form')) agentStudio.drafts[state.currentAgent.id] = agentCollect(); }
function openAgent(id, prefill) {
  agentResetSession(); agentSaveDraft();
  const agent = agentItems().find(a => a.id === id); if (!agent) return;
  const epoch = ++agentStudio.epoch;
  state.currentAgent = agent; agentStudio.run = null; agentStudio.parentRunId = prefill?.options?.parentRunId || null;
  const values = prefill || agentStudio.drafts[id] || {}, conf = agent.workbench || {};
  $('workspace-agent-name').textContent = agent.icon + ' ' + agent.name;
  $('agent-market').style.display = 'none'; $('agent-workspace').classList.add('active'); $('agent-result').style.display = 'block';
  const sourceLabels = { manual: '手工输入', file: '文件导入', store: '授权店铺', knowledge_base: '知识库' };
  const sourceHint = (conf.dataSources || []).map(s => sourceLabels[s] || s).join('、');
  const reviewHint = conf.requiresReview ? ' · 结果必须人工复核' : '';
  $('agent-input-panel').innerHTML = `<form id="agent-form" onsubmit="event.preventDefault();runAgent()"><div class="card-title">${agentEscape(conf.label || '智能分析')} · 输入信息</div><p class="agent-field-help">${agentEscape(agent.desc)}</p><div class="agent-note">可用数据来源：${agentEscape(sourceHint)}${agentEscape(reviewHint)}</div><div class="agent-form-actions"><button type="button" class="btn btn-outline btn-sm" onclick="agentUseExample()">填入示例</button><button type="button" class="btn btn-outline btn-sm" onclick="agentClearForm()">清空表单</button></div><div class="form-group"><label class="form-label" for="agent-input-1">${agentEscape(conf.inputLabel || '商品名称 / 分析对象')} *</label><input class="form-input" id="agent-input-1" required maxlength="4000" value="${agentEscape(values.input || '')}" placeholder="${agentEscape(conf.example || '请输入分析对象')}"></div><div class="agent-form-fields">${agentFields(agent).map(f => agentFormField(f, values.options?.[f.key])).join('')}</div><div class="form-group"><label class="form-label" for="agent-extra">补充要求</label><textarea class="form-textarea" id="agent-extra" maxlength="12000" placeholder="关注的问题、约束条件或希望改进的方向">${agentEscape(values.extra || '')}</textarea></div>${conf.supportsBatch ? '<details><summary class="agent-field-help">批量任务（最多 5 个对象，共用以上参数）</summary><textarea class="form-textarea" id="agent-batch-input" maxlength="20000" placeholder="一行一个商品名称 / 分析对象；留空时执行单个任务"></textarea></details>' : ''}<button class="btn btn-primary agent-submit" id="agent-submit" type="submit" ${agentStudio.busy ? 'disabled' : ''}>${['copy', 'title', 'image', 'plan'].includes(conf.type) ? '开始生成' : '开始分析'}</button><div class="agent-privacy-hint">分析仅依据已提供的数据与授权店铺数据。缺失指标会标注，生成结果自动保存至运行历史。</div></form>`;
  if (agentFields(agent).some(f => f.type === 'shops')) agentFillShopField(values.options?.shopIds || []);
  $('agent-result-content').innerHTML = '<div class="agent-empty"><div class="agent-empty-symbol">✦</div><strong>准备好，开始你的下一步</strong><br>填写左侧信息，结果将在这里展示。<br>可先填入示例体验。</div>';
  agentRecentHistory(id, epoch);
}
function backToAgentMarket() { agentSaveDraft(); agentStudio.epoch++; agentStudio.run = null; $('agent-market').style.display = 'block'; $('agent-workspace').classList.remove('active'); state.currentAgent = null; }
function agentClearForm() { const id = state.currentAgent.id; agentStudio.drafts[id] = {}; openAgent(id, {}); }
function agentUseExample() {
  const a = state.currentAgent;
  openAgent(a.id, { input: a.workbench?.example || '示例商品', extra: '以下为体验示例，请使用自己的商品信息替换后再正式运行。', options: { sellingPoints: '容量 350ml\n可拆洗杯盖', audience: '通勤上班族', scene: '通勤途中', keywords: '随行杯,咖啡杯', reviews: '杯盖清洗方便，尺寸适合通勤。\n包装完整，物流及时。\n杯盖没有拧紧时出现漏水，希望有使用说明。', dataText: '商品名称,售价,总成本\n示例A,99,60\n示例B,129,135', visualStyle: '米白背景、自然光、简约摄影' } });
}
async function agentImportText(el, key, limit) {
  const file = el.files?.[0], epoch = agentStudio.epoch; if (!file) return;
  try {
    if (!/\.(csv|txt)$/i.test(file.name) || file.size > 512000) throw new Error('请使用 500KB 以内的 CSV / TXT 文件');
    const text = (await file.text()).replace(/^\uFEFF/, '');
    if (text.length > limit) throw new Error(`文件内容超过 ${limit} 字符，请分批导入`);
    if (epoch === agentStudio.epoch) { $('af-' + key).value = text; agentToast('已导入文件内容'); }
  } catch (e) { agentToast(e.message, 'error'); } el.value = '';
}
async function agentUploadImage(el) {
  const file = el.files?.[0], epoch = agentStudio.epoch; if (!file) return;
  agentStudio.uploads++;
  try {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) throw new Error('请选择 8MB 以内的 PNG、JPEG 或 WebP 图片');
    const up = await uploadFile(file);
    if (epoch === agentStudio.epoch) { $('af-referenceImage').value = up.url; $('agent-image-preview').innerHTML = agentImagePreview(up.url); }
  } catch (e) { agentToast(e.message, 'error'); } finally { agentStudio.uploads--; }
}
async function runAgent(revision, index) {
  if (agentStudio.busy) return agentToast('正在生成，请等待当前任务结束', 'warn');
  if (agentStudio.uploads) return agentToast('图片上传中，请稍后再生成', 'warn');
  if (!$('agent-form')?.reportValidity()) return;
  const agent = state.currentAgent, epoch = agentStudio.epoch, payload = agentCollect();
  const batch = revision ? [] : ($('agent-batch-input')?.value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (batch.length > 5) return agentToast('每批最多 5 个分析对象', 'warn');
  if (revision && agentStudio.run) { payload.options.previousContent = agentPlain(index === undefined ? agentStudio.run.result : agentResultItems()[index]).slice(0, 16000); payload.options.revision = revision; if (index !== undefined) payload.options.count = 1; }
  agentSaveDraft(); agentStudio.busy = true; $('agent-submit').disabled = true; agentStudio.run = null;
  $('agent-result-content').innerHTML = `<div class="agent-empty" role="status"><span class="agent-spinner"></span><p>${batch.length ? `正在顺序处理 ${batch.length} 个任务` : agent.workbench?.type === 'image' && payload.options.renderMode === '生成图片' ? '正在生成主图，图片任务可能需要几分钟' : '正在处理输入并生成结果'}…</p><p>结果会自动保存。离开此工作台不会撤销已提交的任务。</p></div>`;
  try {
    const data = await API.post('/agents/' + agent.id + (batch.length ? '/batch' : '/run'), batch.length ? { items: batch.map(input => ({ ...payload, input })) } : payload);
    if (epoch !== agentStudio.epoch || agentStudio.user !== (localStorage.getItem('zy_token') || '')) return;
    if (batch.length) $('agent-result-content').innerHTML = `<div class="card-title">批量结果 · ${data.success}/${data.total} 成功</div><div class="agent-batch-list">${data.results.map((r, i) => `<div class="agent-output-card"><div><strong>${agentEscape(batch[i])}</strong><p>${r.status === 'success' ? '已保存到运行历史' : agentEscape(r.error)}</p></div>${r.runId ? `<button class="btn btn-outline" onclick="agentOpenRun(${Number(r.runId)})">打开结果</button>` : ''}</div>`).join('')}</div>`;
    else { agentStudio.run = data; agentRenderResult(); }
    agentRecentHistory(agent.id, epoch);
  } catch (e) { if (epoch === agentStudio.epoch) $('agent-result-content').innerHTML = `<div class="agent-note error">${agentEscape(e.message)}</div><button class="btn btn-outline" onclick="runAgent()">重试</button>`; }
  finally { agentStudio.busy = false; if ($('agent-submit')) $('agent-submit').disabled = false; }
}
function agentPlain(value, level = 0) {
  if (value === null || value === undefined) return '待补充'; if (typeof value !== 'object') return String(value); if (level > 10) return '…';
  if (Array.isArray(value)) return value.map((v, i) => `${i + 1}. ${agentPlain(v, level + 1)}`).join('\n');
  return Object.entries(value).map(([k, v]) => `${agentLabels[k] || k}：${agentPlain(v, level + 1)}`).join('\n');
}
function agentValue(value, depth = 0) {
  if (value === null || value === undefined) return '<span style="color:var(--text-muted)">待补充</span>';
  if (typeof value !== 'object') return agentEscape(value); if (depth > 6) return agentEscape(JSON.stringify(value));
  if (Array.isArray(value)) return value.length ? `<ul>${value.map(v => `<li>${agentValue(v, depth + 1)}</li>`).join('')}</ul>` : '<span style="color:var(--text-muted)">暂无</span>';
  return `<dl class="agent-definition">${Object.entries(value).map(([k, v]) => `<dt>${agentEscape(agentLabels[k] || k)}</dt><dd>${agentValue(v, depth + 1)}</dd>`).join('')}</dl>`;
}
function agentResultItems() { const r = agentStudio.run?.result, key = state.currentAgent?.workbench?.resultKey; return r && Array.isArray(r[key]) ? r[key] : []; }
function agentRenderResult() {
  const run = agentStudio.run; if (!run) return;
  const result = run.result || {}, conf = state.currentAgent.workbench || {}, items = agentResultItems(), a = agentEscape, creative = ['copy', 'title'].includes(conf.type);
  const cards = items.map((item, i) => {
    const row = item && typeof item === 'object' ? item : { content: item }, title = row.title || row.name || row.keyword || row.dimension || `结果 ${i + 1}`;
    const detail = Object.fromEntries(Object.entries(row).filter(([k]) => !['title', 'content', 'checks'].includes(k)));
    return `<article class="agent-output-card"><h4><span class="agent-pill">${String(i + 1).padStart(2, '0')}</span> ${a(title)}</h4>${row.content !== undefined ? `<div class="agent-output-body">${a(row.content)}</div>` : ''}${agentValue(detail)}${Array.isArray(row.checks) && row.checks.length ? `<div class="agent-note warning">${agentValue(row.checks)}</div>` : ''}<div class="agent-output-actions"><button class="btn btn-outline" onclick="agentCopy(${i})">复制${creative ? '正文' : '结果'}</button>${creative ? `<button class="btn btn-outline" onclick="runAgent('缩短，保留核心卖点',${i})">精简</button><button class="btn btn-outline" onclick="runAgent('扩写，保留事实并遵守字数上限',${i})">扩写</button><button class="btn btn-outline" onclick="runAgent('改成自然口语表达',${i})">口语化</button><button class="btn btn-outline" onclick="runAgent('改成高端质感表达，不增加未提供的事实',${i})">高端风格</button>` : ''}${conf.type === 'plan' ? `<button class="btn btn-primary" onclick="agentHandoff('a9',${i})">用此方案生成主图</button>` : ''}</div></article>`;
  }).join('');
  const extra = typeof result === 'object' ? Object.entries(result).filter(([k]) => !['overview', conf.resultKey, 'warnings', 'images', 'parse_error', 'data_source'].includes(k)) : [['content', result]];
  const images = Array.isArray(result.images) ? `<div class="agent-section-title">生成图片</div><div class="agent-images">${result.images.map((img, i) => /^\/uploads\/generated\/[a-zA-Z0-9_.?=%-]+$/.test(img.url || '') ? `<article class="agent-output-card"><img src="${a(__apiUrl(img.url))}" alt="${a(img.title || '生成主图')}" loading="lazy"><div class="agent-output-actions"><button class="btn btn-outline" onclick="agentDownloadImage(${i})">下载原图</button></div></article>` : '<div class="agent-note warning">图片链接不可用，请从历史记录重新打开。</div>').join('')}</div>` : '';
  $('agent-result-content').innerHTML = `<div class="agent-result-toolbar"><button class="btn btn-outline btn-sm" onclick="agentCopy()">复制全部</button><button class="btn btn-outline btn-sm" onclick="agentFavorite()">${run.favorite ? '★ 已收藏' : '☆ 收藏'}</button><select id="agent-export-format" class="form-select" aria-label="导出格式"><option value="txt">文本 TXT</option><option value="csv">表格 CSV</option><option value="xls">Excel XML</option><option value="json">JSON</option></select><button class="btn btn-outline btn-sm" onclick="agentExport()">导出</button><button class="btn btn-outline btn-sm" onclick="runAgent()">重新生成</button></div><div class="agent-result-meta">记录 #${Number(run.runId)} · ${run.source === 'llm' ? 'AI 模型生成' : '本地模板 / 规则'}${run.model ? ' · ' + a(run.model) : ''} · 文字推理 ${((run.duration_ms || 0) / 1000).toFixed(1)} 秒${run.tokens_in || run.tokens_out ? ` · ${Number(run.tokens_in || 0) + Number(run.tokens_out || 0)} tokens` : ''}</div>${run.source !== 'llm' ? '<div class="agent-note warning">当前结果来自本地规则 / 模板，未使用大模型。市场指标和分析结论需要真实数据验证。</div>' : ''}${result.parse_error ? '<div class="agent-note warning">模型回复未能解析为标准结构，已保留原文，可重新生成。</div>' : ''}${Array.isArray(result.warnings) && result.warnings.length ? `<div class="agent-note warning">${agentValue(result.warnings)}</div>` : ''}<div class="agent-output-body">${a(result.overview || '')}</div><div class="agent-section-title">${a(agentLabels[conf.resultKey] || '执行结果')}${items.length ? ' · ' + items.length : ''}</div><div class="agent-result-list">${cards}</div>${images}${extra.map(([key, v]) => `<div class="agent-section-title">${a(agentLabels[key] || key)}</div><div class="agent-output-card">${agentValue(v)}</div>`).join('')}${(conf.next || []).length ? `<div class="agent-handoff"><div class="agent-section-title">继续下一步</div>${conf.next.map(id => `<button class="btn btn-outline" onclick="agentHandoff('${id}')">${a(agentItems().find(x => x.id === id)?.name || id)} →</button>`).join('')}</div>` : ''}`;
}
async function agentCopy(index) {
  const value = index === undefined ? agentStudio.run?.result : agentResultItems()[index];
  const content = index === undefined ? agentPlain(value) : value?.content || (['copy', 'title'].includes(state.currentAgent.workbench?.type) ? value?.title : '') || agentPlain(value);
  try { await navigator.clipboard.writeText(content); agentToast('已复制'); } catch { agentToast('剪贴板不可用，请选择文本手动复制，或导出 TXT', 'warn'); }
}
async function agentFavorite() {
  const run = agentStudio.run; if (!run) return;
  try { const data = await API.patch('/agent-runs/' + run.runId, { favorite: !run.favorite }); if (agentStudio.run === run) { run.favorite = data.favorite; agentRenderResult(); } }
  catch (e) { agentToast(e.message, 'error'); }
}
function agentDownloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function agentExport() {
  const run = agentStudio.run; if (!run) return;
  try { const data = await API.post('/agent-runs/' + run.runId + '/export', { format: $('agent-export-format').value }); agentDownloadBlob(new Blob([data.content], { type: data.mime + ';charset=utf-8' }), data.filename); }
  catch (e) { agentToast(e.message, 'error'); }
}
async function agentDownloadImage(index) {
  try {
    const img = agentStudio.run?.result?.images?.[index]; if (!img || !img.url.startsWith('/uploads/generated/')) return;
    const response = await fetch(__apiUrl(img.url)); if (!response.ok) throw new Error('图片链接已过期，请从历史记录重新打开'); agentDownloadBlob(await response.blob(), `main-image-${index + 1}.jpg`);
  } catch (e) { agentToast(e.message, 'error'); }
}
function agentHandoff(id, index) {
  const run = agentStudio.run; if (!run) return;
  const item = index === undefined ? null : agentResultItems()[index], result = run.result, options = { ...(run.options || {}) };
  delete options.revision; delete options.previousContent;
  if (id === 'a9') { options.imagePrompt = item?.prompt || (result.plans || []).map(p => p.prompt || '').join('\n'); options.renderMode = '仅生成方案'; if (item) options.count = 1; }
  if (id === 'a7' && Array.isArray(result.keywords)) options.keywords = result.keywords.map(k => typeof k === 'string' ? k : k.keyword || '').join('\n');
  if (id === 'a17' && Array.isArray(result.selling_points) && result.selling_points.length) options.sellingPoints = agentPlain(result.selling_points);
  options.parentRunId = run.runId;
  openAgent(id, { input: run.input, options, extra: `来自${run.agent_name}，来源：${run.source === 'llm' ? 'AI 生成，需核验' : '模板 / 规则，未验证'}。仅作参考，不能作为未确认的商品事实：\n${agentPlain(item || result).slice(0, 10500)}` });
}
async function agentRecentHistory(id, epoch) {
  $('agent-workspace-history').innerHTML = '';
  try {
    const { runs } = await API.get('/agent-runs?limit=5&agent_id=' + id); if (epoch !== agentStudio.epoch) return;
    $('agent-workspace-history').innerHTML = `<div class="agent-section-title">最近运行 · ${agentEscape(state.currentAgent?.name || '')}</div><div class="agent-history-list">${runs.map(r => `<button class="agent-history-item" onclick="agentOpenRun(${Number(r.id)})"><div><strong>${r.favorite ? '★ ' : ''}${agentEscape(r.input)}</strong><small>${agentEscape(r.created_at)} · ${r.source === 'llm' ? 'AI 生成' : '模板 / 规则'}</small></div><span>回填参数并查看 →</span></button>`).join('') || '<div class="agent-note">暂无记录，完成一次生成后会自动保存在这里。</div>'}</div>`;
  } catch { if (epoch === agentStudio.epoch) $('agent-workspace-history').textContent = '暂时无法读取历史记录。'; }
}
async function agentOpenRun(id) {
  try {
    if (!agentItems().length) await loadAgents(); const run = await API.get('/agent-runs/' + id);
    navigate('agents'); openAgent(run.agent_id, { input: run.input, extra: run.extra || '', options: run.options || {} });
    agentStudio.run = { ...run, runId: run.id, result: run.result_parsed || { overview: run.result } }; agentRenderResult();
  } catch (e) { agentToast(e.message, 'error'); }
}
async function agentLoadHistory(reset = false) {
  if (reset) agentStudio.historyPage = 0;
  const tb = $('agent-runs-tbody'); tb.innerHTML = '<tr><td colspan="7">加载中…</td></tr>';
  if (!$('agent-history-filters')) {
    const div = document.createElement('div'); div.id = 'agent-history-filters'; div.className = 'agent-tools';
    div.innerHTML = '<input id="agent-history-query" class="form-input" placeholder="搜索商品 / 分析对象" aria-label="搜索历史"><select id="agent-history-kind" class="form-select" aria-label="按智能体筛选"><option value="">全部智能体</option></select><select id="agent-history-favorite" class="form-select" aria-label="收藏筛选"><option value="">全部记录</option><option value="1">仅收藏</option></select><input id="agent-history-from" type="date" class="form-input" style="width:auto" aria-label="起始日期"><input id="agent-history-to" type="date" class="form-input" style="width:auto" aria-label="截止日期"><button class="btn btn-outline" onclick="agentLoadHistory(true)">筛选</button>';
    $('view-agent-runs').prepend(div);
  }
  try {
    if (!agentItems().length) await loadAgents(); const kind = $('agent-history-kind');
    if (kind.options.length === 1) kind.innerHTML += agentItems().map(a => `<option value="${a.id}">${agentEscape(a.name)}</option>`).join('');
    const p = new URLSearchParams({ limit: '20', offset: String(agentStudio.historyPage * 20), q: $('agent-history-query').value, favorite: $('agent-history-favorite').value, agent_id: kind.value, date_start: $('agent-history-from').value, date_end: $('agent-history-to').value });
    const data = await API.get('/agent-runs?' + p);
    tb.innerHTML = data.runs.map(r => `<tr><td style="padding:10px">${Number(r.id)}</td><td>${agentEscape(r.agent_name)}</td><td>${agentEscape(r.input.slice(0, 40))}</td><td>${r.source === 'llm' ? 'AI' : '模板 / 规则'}</td><td>${Number(r.duration_ms)}ms</td><td>${agentEscape(r.created_at)}</td><td><button class="btn btn-outline btn-sm" onclick="agentOpenRun(${Number(r.id)})">打开</button> <button class="btn btn-outline btn-sm" aria-label="收藏记录" onclick="agentToggleHistoryFavorite(${Number(r.id)},${!r.favorite})">${r.favorite ? '★' : '☆'}</button> <button class="btn btn-outline btn-sm" onclick="agentDeleteRun(${Number(r.id)})">删除</button></td></tr>`).join('') || '<tr><td colspan="7" style="padding:24px">没有匹配的运行记录。</td></tr>';
    tb.innerHTML += `<tr><td colspan="7" style="padding:12px">共 ${data.total} 条 · 第 ${agentStudio.historyPage + 1} 页 <button class="btn btn-outline btn-sm" ${agentStudio.historyPage === 0 ? 'disabled' : ''} onclick="agentStudio.historyPage--;agentLoadHistory()">上一页</button> <button class="btn btn-outline btn-sm" ${(agentStudio.historyPage + 1) * 20 >= data.total ? 'disabled' : ''} onclick="agentStudio.historyPage++;agentLoadHistory()">下一页</button></td></tr>`;
  } catch (e) { tb.innerHTML = `<tr><td colspan="7">${agentEscape(e.message)}</td></tr>`; }
}
async function agentToggleHistoryFavorite(id, favorite) { try { await API.patch('/agent-runs/' + id, { favorite }); await agentLoadHistory(); } catch (e) { agentToast(e.message, 'error'); } }
async function agentDeleteRun(id) { if (!confirm('删除这条运行记录？删除后无法从历史记录恢复。')) return; try { await API.del('/agent-runs/' + id); await agentLoadHistory(); } catch (e) { agentToast(e.message, 'error'); } }
