// ===== 阶段 8 · 数据导入视图 =====
// 自 public/index.html 拆分（阶段 8 并行开发）。作为全局脚本，加载顺序须早于主脚本。

// ---------- 数据导入 ----------
let importTypes = [];
async function initImport() {
  if (!importTypes.length) {
    try { importTypes = (await API.get('/stores/import/types')).types || []; } catch (_) { importTypes = []; }
    const sel = $('import-type');
    if (sel) sel.innerHTML = '<option value="auto">自动识别</option>' + importTypes.map(t => `<option value="${t.value}">${esc(t.label)}</option>`).join('');
  }
  loadImportBatches();
}
async function downloadImportTemplate() {
  const type = ($('import-type') && $('import-type').value) || 'daily_report';
  if (type === 'auto') { showToast('请选择具体类型以下载模板', 'warn'); return; }
  try {
    const resp = await authedFetch('/stores/import/template?type=' + encodeURIComponent(type));
    if (!resp.ok) throw new Error('下载失败');
    const blob = await resp.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `import_${type}_template.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) { showToast(e.message, 'error'); }
}
async function submitImport() {
  const fileEl = $('import-file');
  if (!fileEl || !fileEl.files.length) { showToast('请选择 CSV 文件', 'warn'); return; }
  const type = ($('import-type') && $('import-type').value) || 'auto';
  const fd = new FormData();
  fd.append('file', fileEl.files[0]);
  const box = $('import-result');
  box.innerHTML = '导入中…';
  try {
    const resp = await authedFetch('/stores/import/csv?type=' + encodeURIComponent(type), { method: 'POST', body: fd });
    const body = await resp.json();
    if (!resp.ok && !body.report) throw new Error(body.error || '导入失败');
    const r = body.report || {};
    const warn = (r.warnings || []).slice(0, 5).map(w => `<li>第${w.row}行 ${esc(w.field)}：${esc(w.message)}</li>`).join('');
    const errs = (r.errors || []).slice(0, 5).map(w => `<li>第${w.row}行 ${esc(w.field)}：${esc(w.message)}</li>`).join('');
    box.innerHTML = `<div style="padding:10px;border-radius:8px;background:var(--bg);">
      <div>状态：<b>${esc(r.status)}</b> ｜ 总行 ${r.total} ｜ 新增 ${r.inserted} ｜ 更新 ${r.updated} ｜ 失败 ${r.failed}</div>
      ${warn ? `<div style="margin-top:6px;color:#d97706;">质量告警：<ul style="margin:4px 0 0 18px;">${warn}</ul></div>` : ''}
      ${errs ? `<div style="margin-top:6px;color:#dc2626;">错误：<ul style="margin:4px 0 0 18px;">${errs}</ul></div>` : ''}
    </div>`;
    showToast('导入完成', 'success');
    fileEl.value = '';
    loadImportBatches();
  } catch (e) { box.innerHTML = `<span style="color:#dc2626;">${esc(e.message)}</span>`; }
}
async function loadImportBatches() {
  const tb = $('import-batches-tbody');
  if (!tb) return;
  try {
    const data = await API.get('/stores/import/batches');
    const rows = data.batches || [];
    if (!rows.length) { tb.innerHTML = emptyState('暂无导入批次，先上传一个 CSV 试试', 8); return; }
    const statusMap = { success: '<span style="color:#10b981;">成功</span>', partial: '<span style="color:#d97706;">部分成功</span>', failed: '<span style="color:#dc2626;">失败</span>', running: '处理中' };
    tb.innerHTML = rows.map(b => `<tr style="border-bottom:1px solid var(--border);">
      <td style="padding:8px;">${b.id}</td>
      <td style="padding:8px;">${esc(b.file_name || '—')}</td>
      <td style="padding:8px;">${statusMap[b.status] || esc(b.status)}</td>
      <td style="padding:8px;">${b.total_rows}</td>
      <td style="padding:8px;">${b.success_rows}</td>
      <td style="padding:8px;">${b.failed_rows}</td>
      <td style="padding:8px;">${esc(b.created_at || '')}</td>
      <td style="padding:8px;"><button class="btn btn-outline" style="padding:2px 8px;font-size:11px;" onclick="viewImportBatch(${b.id})">详情</button></td>
    </tr>`).join('');
  } catch (e) { tb.innerHTML = emptyState('加载失败：' + e.message, 8); }
}
async function viewImportBatch(id) {
  try {
    const { batch } = await API.get('/stores/import/batches/' + id);
    const summary = batch.summary_json || {};
    const errs = (batch.errors_json || []).map(e => `<li>第${e.row}行 ${esc(e.field)}：${esc(e.message)}</li>`).join('');
    const warns = (batch.warnings_json || []).map(e => `<li>第${e.row}行 ${esc(e.field)}：${esc(e.message)}</li>`).join('');
    openGenericModal('导入批次 #' + id, `
      <div>类型：${esc(summary.type || '—')} ｜ 新增 ${summary.inserted || 0} ｜ 更新 ${summary.updated || 0} ｜ 告警 ${summary.warnings || 0}</div>
      ${warns ? `<h4 style="margin:12px 0 4px;">质量告警</h4><ul style="margin:0 0 0 18px;">${warns}</ul>` : ''}
      ${errs ? `<h4 style="margin:12px 0 4px;">错误</h4><ul style="margin:0 0 0 18px;">${errs}</ul>` : '<p style="margin-top:10px;">无错误</p>'}`);
  } catch (e) { showToast(e.message, 'error'); }
}

