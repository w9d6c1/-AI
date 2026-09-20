// ===== 阶段 8 · 执行对账视图 =====
// 自 public/index.html 拆分（阶段 8 并行开发）。作为全局脚本，加载顺序须早于主脚本。

// ---------- 执行对账 ----------
async function initReconcile() {
  if (!$('recon-start').value) { $('recon-start').value = daysAgoStr(30); $('recon-end').value = todayStr(); }
  await fillShopSelect('recon-shop');
  loadReconcile();
}
async function loadReconcile() {
  const tb = $('recon-tbody');
  if (!tb) return;
  const p = new URLSearchParams({ date_start: $('recon-start').value, date_end: $('recon-end').value });
  if ($('recon-shop').value) p.set('shop_id', $('recon-shop').value);
  tb.innerHTML = emptyState('查询中…', 9);
  try {
    const data = await API.get('/stores/reconcile/report?' + p.toString());
    const s = data.summary || {};
    $('recon-summary').innerHTML = [
      ['可对账数', s.comparable, ''],
      ['一致', s.matched, '#10b981'],
      ['不一致', s.mismatched, '#dc2626'],
      ['匹配率', (s.match_rate === null || s.match_rate === undefined ? '—' : s.match_rate + '%'), '']
    ].map(([label, val, color]) => `<div class="metric-card"><div class="metric-label">${label}</div><div class="metric-value" style="color:${color || 'inherit'}">${val === undefined ? '—' : val}</div></div>`).join('');
    const rows = data.rows || [];
    if (!rows.length) { tb.innerHTML = emptyState('该时间范围内暂无执行记录', 9); return; }
    tb.innerHTML = rows.map(r => `<tr style="border-bottom:1px solid var(--border);">
      <td style="padding:8px;">${r.id}</td>
      <td style="padding:8px;">${esc(r.shop_name || '')}</td>
      <td style="padding:8px;">${esc(r.action_type)}</td>
      <td style="padding:8px;">${esc(r.target_campaign_id || '')}</td>
      <td style="padding:8px;">${r.before_value ?? '—'}</td>
      <td style="padding:8px;">${r.expected_value ?? '—'}</td>
      <td style="padding:8px;">${r.actual_value ?? '—'}</td>
      <td style="padding:8px;">${r.diff ?? '—'}</td>
      <td style="padding:8px;">${r.matched === null ? '<span style="color:var(--text-muted);">无法比对</span>' : (r.matched ? '<span style="color:#10b981;">一致</span>' : '<span style="color:#dc2626;">不一致</span>')}</td>
    </tr>`).join('');
  } catch (e) { tb.innerHTML = emptyState('加载失败：' + e.message, 9); }
}
async function exportReconcile() {
  try {
    const body = { name: '执行对账', report_type: 'reconcile_report', file_format: 'csv', date_start: $('recon-start').value, date_end: $('recon-end').value };
    if ($('recon-shop').value) body.shop_ids = [Number($('recon-shop').value)];
    const created = await API.post('/reports', body);
    const token = localStorage.getItem('zy_token');
    const resp = await fetch('/api/reports/' + created.id + '/download', { headers: { Authorization: 'Bearer ' + token } });
    const blob = await resp.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'reconcile_report.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) { showToast(e.message, 'error'); }
}

