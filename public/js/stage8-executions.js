// ===== 阶段 8 · 执行闭环视图（列表筛选/分页 + 详情证据 + 审批/驳回/回滚 + 导出 + 批量回填）=====
// 自 public/index.html 拆分并增强。作为全局脚本，加载顺序须早于主脚本。

const EXEC_LIMIT = 50;
let execOffset = 0;

const EXEC_STATUS = {
  pending_manual: { label: '待人工执行', tag: 'tag-info' },
  pending_approval: { label: '待审批', tag: 'tag-warning' },
  queued: { label: '排队中', tag: 'tag-primary' },
  running: { label: '执行中', tag: 'tag-warning' },
  success: { label: '成功', tag: 'tag-success' },
  failed: { label: '失败', tag: 'tag-danger' },
  rejected: { label: '已驳回', tag: 'tag-danger' },
  rolled_back: { label: '已回滚', tag: 'tag-info' }
};

function execStatusTag(s) {
  const m = EXEC_STATUS[s] || { label: s, tag: '' };
  return `<span class="tag ${m.tag}">${esc(m.label)}</span>`;
}

async function initExecutions() {
  if (!$('exec-start').value) { $('exec-start').value = daysAgoStr(30); $('exec-end').value = todayStr(); }
  await fillShopSelect('exec-shop');
  execOffset = 0;
  loadExecutions();
}

function execResetPage() { execOffset = 0; loadExecutions(); }

function execPage(dir) {
  const next = execOffset + dir * EXEC_LIMIT;
  if (next < 0) return;
  execOffset = next;
  loadExecutions();
}

function execQuery() {
  const p = new URLSearchParams();
  if ($('exec-status-filter').value) p.set('status', $('exec-status-filter').value);
  if ($('exec-shop').value) p.set('shop_id', $('exec-shop').value);
  if ($('exec-auto').value) p.set('is_auto', $('exec-auto').value);
  if ($('exec-start').value) p.set('date_start', $('exec-start').value);
  if ($('exec-end').value) p.set('date_end', $('exec-end').value);
  p.set('limit', String(EXEC_LIMIT));
  p.set('offset', String(execOffset));
  return p;
}

async function loadExecutions() {
  const tb = $('exec-tbody');
  if (!tb) return;
  tb.innerHTML = emptyState('加载中…', 11);
  try {
    const data = await API.get('/stores/executions?' + execQuery().toString());
    const rows = data.executions || [];
    if (!rows.length) {
      tb.innerHTML = emptyState('该筛选条件下暂无执行记录', 11);
      $('exec-page-info').textContent = '';
      return;
    }
    const admin = isAdminUser();
    tb.innerHTML = rows.map(e => {
      const actions = [];
      if (e.status === 'pending_approval' && admin) {
        actions.push(`<button class="btn btn-success btn-sm" style="padding:2px 8px;font-size:11px;" onclick="approveExecution(${e.id})">通过</button>`);
        actions.push(`<button class="btn btn-outline btn-sm" style="padding:2px 8px;font-size:11px;" onclick="rejectExecution(${e.id})">驳回</button>`);
      }
      if (e.status === 'pending_manual' && admin) {
        actions.push(`<button class="btn btn-primary btn-sm" style="padding:2px 8px;font-size:11px;" onclick="backfillExecution(${e.id})">回填</button>`);
      }
      if (e.status === 'success' && admin) {
        actions.push(`<button class="btn btn-outline btn-sm" style="padding:2px 8px;font-size:11px;" onclick="rollbackExecution(${e.id})">回滚</button>`);
      }
      actions.push(`<button class="btn btn-outline btn-sm" style="padding:2px 8px;font-size:11px;" onclick="viewExecution(${e.id})">详情</button>`);
      return `<tr style="border-bottom:1px solid var(--border);">
        <td style="padding:8px;">${e.id}</td>
        <td style="padding:8px;">${esc(e.shop_name || '店铺#' + e.shop_id)}</td>
        <td style="padding:8px;">${esc(e.target_campaign_id || '—')}</td>
        <td style="padding:8px;">${esc(e.action_type || '—')}</td>
        <td style="padding:8px;">${e.expected_value ?? '—'}</td>
        <td style="padding:8px;">${e.actual_value ?? '—'}</td>
        <td style="padding:8px;">${e.is_auto ? '自动' : '人工'}</td>
        <td style="padding:8px;">${execStatusTag(e.status)}</td>
        <td style="padding:8px;">${e.screenshot_url ? `<a href="${esc(e.screenshot_url)}" target="_blank" style="color:var(--primary);">查看</a>` : '—'}</td>
        <td style="padding:8px;font-size:12px;">${esc(e.created_at || '—')}</td>
        <td style="padding:8px;white-space:nowrap;">${actions.join(' ')}</td>
      </tr>`;
    }).join('');
    $('exec-page-info').textContent = `第 ${Math.floor(execOffset / EXEC_LIMIT) + 1} 页 · 本页 ${rows.length} 条`;
  } catch (e) {
    tb.innerHTML = emptyState('加载失败：' + e.message, 11);
  }
}

async function viewExecution(id) {
  try {
    const { execution: e, evidence } = await API.get('/stores/executions/' + id);
    const audit = (evidence && evidence.audit) || [];
    const shot = evidence && evidence.screenshot_url;
    openGenericModal('执行详情 #' + e.id, `
      <div class="grid grid-2" style="gap:8px;">
        <div>店铺：${esc(e.shop_name || '店铺#' + e.shop_id)}</div>
        <div>状态：${execStatusTag(e.status)}</div>
        <div>计划：${esc(e.target_campaign_id || '—')}</div>
        <div>动作：${esc(e.action_type || '—')}</div>
        <div>执行前值：${e.before_value ?? '—'}</div>
        <div>期望值：${e.expected_value ?? '—'}</div>
        <div>实际值：${e.actual_value ?? '—'}</div>
        <div>来源：${e.is_auto ? '自动' : '人工'}</div>
        <div>创建：${esc(e.created_at || '—')}</div>
        <div>完成：${esc(e.finished_at || '—')}</div>
      </div>
      ${e.error_msg ? `<div style="margin-top:10px;color:#dc2626;">错误：${esc(e.error_msg)}</div>` : ''}
      ${shot ? `<div style="margin-top:12px;"><a href="${esc(shot)}" target="_blank" style="color:var(--primary);">查看执行截图</a></div>` : ''}
      <h4 style="margin:14px 0 6px;">审计留痕</h4>
      ${audit.length ? `<ul style="margin:0 0 0 18px;">${audit.map(a => `<li>${esc(a.created_at || '')} · ${esc(a.action)}${a.ip_address ? '（' + esc(a.ip_address) + '）' : ''}</li>`).join('')}</ul>` : '<div style="color:var(--text-muted);">无</div>'}
    `);
  } catch (e) { showToast(e.message, 'error'); }
}

function approveExecution(id) {
  customConfirm('确认通过该自动执行任务？通过后将进入派发倒计时。', '审批通过', async () => {
    try { await API.post('/stores/executions/' + id + '/approve'); showToast('已通过', 'success'); loadExecutions(); }
    catch (e) { showToast(e.message, 'error'); }
  });
}

function rejectExecution(id) {
  customConfirm('确认驳回该自动执行任务？驳回后不再执行。', '驳回执行', async () => {
    try { await API.post('/stores/executions/' + id + '/reject'); showToast('已驳回', 'success'); loadExecutions(); }
    catch (e) { showToast(e.message, 'error'); }
  }, { icon: '⛔' });
}

function rollbackExecution(id) {
  customConfirm('将以执行前值创建一条反向执行任务，确认回滚？', '回滚执行', async () => {
    try {
      const r = await API.post('/stores/executions/' + id + '/rollback');
      showToast('已创建回滚执行 #' + (r.execution && r.execution.id), 'success');
      loadExecutions();
    } catch (e) { showToast(e.message, 'error'); }
  }, { icon: '↩️' });
}

function backfillExecution(id) {
  openGenericModal('人工回填 #' + id, `
    <div style="display:flex;flex-direction:column;gap:10px;">
      <div><label style="font-size:12px;">结果</label>
        <select id="exec-bf-status" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;">
          <option value="success">成功</option>
          <option value="failed">失败</option>
        </select></div>
      <div><label style="font-size:12px;">实际值</label>
        <input id="exec-bf-actual" type="number" step="0.01" placeholder="可留空" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;"></div>
      <div><label style="font-size:12px;">备注 / 错误信息</label>
        <input id="exec-bf-note" placeholder="可留空" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;"></div>
      <button class="btn btn-primary btn-sm" onclick="submitExecBackfillOne(${id})">提交回填</button>
    </div>`);
}

async function submitExecBackfillOne(id) {
  const status = $('exec-bf-status').value;
  const actual = $('exec-bf-actual').value;
  const note = ($('exec-bf-note').value || '').trim();
  const body = { status, actual_value: actual === '' ? null : Number(actual) };
  if (status === 'failed') body.error_msg = note || null;
  try {
    await API.post('/stores/executions/' + id + '/backfill', body);
    showToast('回填成功', 'success');
    closeModal('modal-generic');
    loadExecutions();
  } catch (e) { showToast(e.message, 'error'); }
}

async function exportExecutions() {
  const format = $('exec-export-format').value || 'csv';
  const status = $('exec-status-filter').value || 'pending_manual';
  try {
    const resp = await authedFetch('/stores/executions/export?status=' + encodeURIComponent(status) + '&format=' + format);
    if (!resp.ok) throw new Error('导出失败');
    const blob = await resp.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'executions.' + (format === 'xls' ? 'xls' : 'csv');
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) { showToast(e.message, 'error'); }
}

async function submitExecBackfill(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const resp = await authedFetch('/stores/executions/backfill', { method: 'POST', body: fd });
    const body = await resp.json();
    if (!resp.ok) throw new Error(body.error || '回填失败');
    const errs = (body.errors || []).slice(0, 5).map(x => `<li>第${x.row}行：${esc(x.message)}</li>`).join('');
    openGenericModal('批量回填结果', `
      <div>成功 <b>${body.success}</b> 条 ｜ 失败 <b>${body.failed}</b> 条</div>
      ${errs ? `<div style="margin-top:8px;color:#dc2626;">错误示例：<ul style="margin:4px 0 0 18px;">${errs}</ul></div>` : ''}`);
    input.value = '';
    loadExecutions();
  } catch (e) { showToast(e.message, 'error'); input.value = ''; }
}
