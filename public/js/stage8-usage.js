// ===== 阶段 8 · 用量统计视图 =====
// 自 public/index.html 拆分（阶段 8 并行开发）。作为全局脚本，加载顺序须早于主脚本。

// ---------- 用量统计 ----------
async function initUsage() {
  if (!$('usage-start').value) { $('usage-start').value = daysAgoStr(30); $('usage-end').value = todayStr(); }
  loadUsage();
}
async function loadUsage() {
  const tb = $('usage-tbody');
  const atb = $('usage-agent-tbody');
  if (!tb) return;
  const p = new URLSearchParams({ date_start: $('usage-start').value, date_end: $('usage-end').value });
  tb.innerHTML = emptyState('加载中…', 7);
  try {
    const data = await API.get('/usage/stats?' + p.toString());
    const usage = data.usage || [];
    tb.innerHTML = usage.length ? usage.map(u => `<tr style="border-bottom:1px solid var(--border);">
      <td style="padding:8px;">${esc(u.provider || '—')}</td>
      <td style="padding:8px;">${esc(u.capability || '—')}</td>
      <td style="padding:8px;">${esc(u.model || '—')}</td>
      <td style="padding:8px;">${u.calls}</td>
      <td style="padding:8px;">${fmtNum(u.tokens_in)}</td>
      <td style="padding:8px;">${fmtNum(u.tokens_out)}</td>
      <td style="padding:8px;">${Number(u.cost || 0).toFixed(4)}</td>
    </tr>`).join('') : emptyState('该时间段暂无用量记录', 7);
    const byAgent = (data.agent_runs && data.agent_runs.by_agent) || [];
    atb.innerHTML = byAgent.length ? byAgent.map(a => `<tr style="border-bottom:1px solid var(--border);">
      <td style="padding:8px;">${esc(a.agent_name || a.agent_id)}</td>
      <td style="padding:8px;">${a.runs}</td>
      <td style="padding:8px;">${fmtNum(a.tokens_in)}</td>
      <td style="padding:8px;">${fmtNum(a.tokens_out)}</td>
      <td style="padding:8px;">${Number(a.cost || 0).toFixed(4)}</td>
    </tr>`).join('') : emptyState('暂无智能体用量', 5);
  } catch (e) { tb.innerHTML = emptyState('加载失败：' + e.message, 7); }
}

