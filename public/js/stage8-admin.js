// ===== 阶段 8 · 数据保留策略视图（仅管理员）=====
// 作为全局脚本，加载顺序须早于主脚本。

async function initRetention() {
  loadRetentionPolicy();
}

async function loadRetentionPolicy() {
  const tb = $('retention-tbody');
  if (!tb) return;
  tb.innerHTML = emptyState('加载中…', 4);
  try {
    const data = await API.get('/admin/retention/policy');
    const list = data.policies || [];
    if (!list.length) { tb.innerHTML = emptyState('暂无保留策略', 4); return; }
    tb.innerHTML = list.map(p => `<tr style="border-bottom:1px solid var(--border);">
      <td style="padding:8px;">${esc(p.table)}</td>
      <td style="padding:8px;">${esc(p.column)}</td>
      <td style="padding:8px;">${p.days}</td>
      <td style="padding:8px;font-size:12px;">${esc(p.env || '—')}</td>
    </tr>`).join('');
  } catch (e) { tb.innerHTML = emptyState('加载失败：' + e.message, 4); }
}

function runRetention() {
  customConfirm('将按策略永久删除超期数据，确认立即执行？', '执行保留清理', async () => {
    try {
      const data = await API.post('/admin/retention/run');
      const s = data.summary || {};
      const rows = Object.entries(s).map(([k, v]) => `<li>${esc(k)}：${typeof v === 'object' ? esc(JSON.stringify(v)) : v}</li>`).join('');
      $('retention-summary').innerHTML = `<div>清理完成，涉及 ${Object.keys(s).length} 张表。</div><ul style="margin:6px 0 0 18px;">${rows}</ul>`;
      showToast('保留清理完成', 'success');
    } catch (e) { showToast(e.message, 'error'); }
  }, { icon: '🧹' });
}
