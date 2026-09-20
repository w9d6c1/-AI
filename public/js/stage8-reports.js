// ===== 阶段 8 · 报表模板视图（列表 / 新建 / 删除 / 套用）=====
// 作为全局脚本，加载顺序须早于主脚本。

let reportTemplateTypes = [];
let reportTemplatesCache = [];

async function loadReportTemplates() {
  const tb = $('report-templates-list');
  if (!tb) return;
  tb.innerHTML = emptyState('加载中…', 6);
  try {
    await ensureReportTypes();
    const data = await API.get('/report-templates');
    const list = data.templates || [];
    reportTemplatesCache = list;
    if (!list.length) { tb.innerHTML = emptyState('暂无模板，点击「新建模板」创建', 6); return; }
    tb.innerHTML = list.map(t => {
      const cfg = t.config_json || {};
      const cfgText = [cfg.format ? String(cfg.format).toUpperCase() : '', cfg.days ? '近' + cfg.days + '天' : ''].filter(Boolean).join(' / ') || '—';
      return `<tr style="border-bottom:1px solid var(--border);">
      <td style="padding:8px;">${esc(t.name)}</td>
      <td style="padding:8px;">${esc(reportTypeLabel(t.report_type))}</td>
      <td style="padding:8px;">${t.is_default ? '<span class="tag tag-success">默认</span>' : '—'}</td>
      <td style="padding:8px;font-size:12px;color:var(--text-muted);">${esc(cfgText)}</td>
      <td style="padding:8px;font-size:12px;">${esc(t.created_at || '—')}</td>
      <td style="padding:8px;white-space:nowrap;">
        <button class="btn btn-outline btn-sm" style="padding:2px 8px;font-size:11px;" onclick="applyTemplate(${t.id})">套用</button>
        <button class="btn btn-outline btn-sm" style="padding:2px 8px;font-size:11px;" onclick="deleteTemplate(${t.id})">删除</button>
      </td>
    </tr>`;
    }).join('');
  } catch (e) { tb.innerHTML = emptyState('加载失败：' + e.message, 6); }
}

async function ensureReportTypes() {
  if (reportTemplateTypes.length) return reportTemplateTypes;
  try { reportTemplateTypes = (await API.get('/report-types')).types || []; } catch (_) { reportTemplateTypes = []; }
  return reportTemplateTypes;
}

function reportTypeLabel(v) {
  const t = reportTemplateTypes.find(x => x.value === v);
  return t ? t.label : (v || '—');
}

async function showCreateTemplateForm() {
  await ensureReportTypes();
  openGenericModal('新建报表模板', `
    <div style="display:flex;flex-direction:column;gap:10px;">
      <div><label style="font-size:12px;">模板名称</label>
        <input id="tpl-name" placeholder="如：每日经营日报" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;"></div>
      <div><label style="font-size:12px;">报表类型</label>
        <select id="tpl-type" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;">
          ${reportTemplateTypes.map(t => `<option value="${t.value}">${esc(t.label)}</option>`).join('')}
        </select></div>
      <div style="display:flex;gap:10px;">
        <div style="flex:1;"><label style="font-size:12px;">默认格式</label>
          <select id="tpl-format" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;">
            <option value="csv">CSV</option>
            <option value="json">JSON</option>
          </select></div>
        <div style="flex:1;"><label style="font-size:12px;">默认日期范围</label>
          <select id="tpl-days" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;">
            <option value="7">最近 7 天</option>
            <option value="30" selected>最近 30 天</option>
            <option value="90">最近 90 天</option>
          </select></div>
      </div>
      <label style="font-size:12px;"><input type="checkbox" id="tpl-default"> 设为默认模板</label>
      <button class="btn btn-primary btn-sm" onclick="submitTemplateForm()">创建</button>
    </div>`);
}

async function submitTemplateForm() {
  const name = ($('tpl-name').value || '').trim();
  const report_type = $('tpl-type').value;
  const is_default = $('tpl-default').checked;
  const config = { format: $('tpl-format').value, days: Number($('tpl-days').value) || 30 };
  if (!name) { showToast('请输入模板名称', 'warn'); return; }
  try {
    await API.post('/report-templates', { name, report_type, is_default, config });
    showToast('模板已创建', 'success');
    closeModal('modal-generic');
    loadReportTemplates();
  } catch (e) { showToast(e.message, 'error'); }
}

function deleteTemplate(id) {
  customConfirm('确认删除该报表模板？此操作不可恢复。', '删除模板', async () => {
    try { await API.del('/report-templates/' + id); showToast('已删除', 'success'); loadReportTemplates(); }
    catch (e) { showToast(e.message, 'error'); }
  }, { icon: '🗑️' });
}

function applyTemplate(id) {
  const t = reportTemplatesCache.find(x => x.id === id);
  if (!t) return;
  if (typeof showCreateReportForm === 'function') showCreateReportForm();
  const cfg = t.config_json || {};
  if ($('report-name')) $('report-name').value = t.name + ' · ' + todayStr();
  if ($('report-type')) $('report-type').value = t.report_type;
  if ($('report-format') && cfg.format) $('report-format').value = cfg.format;
  if (cfg.days && $('report-date-start-modal')) {
    $('report-date-start-modal').value = daysAgoStr(Number(cfg.days) - 1);
    $('report-date-end-modal').value = todayStr();
  }
  showToast('已套用模板，请确认日期后生成', 'success');
}
