// ===== 阶段 8 · 智能体运行历史视图 =====
// 自 public/index.html 拆分（阶段 8 并行开发）。作为全局脚本，加载顺序须早于主脚本。

// ---------- 智能体运行历史 ----------
async function loadAgentRuns() {
  const tb = $('agent-runs-tbody');
  if (!tb) return;
  pagerRegister('runs', 50, 'loadAgentRuns');
  tb.innerHTML = emptyState('加载中…', 7);
  try {
    const data = await API.get('/agent-runs?' + pagerQuery('runs'));
    const runs = data.runs || [];
    if (!runs.length) { tb.innerHTML = emptyState('暂无智能体运行记录，去「AI 智能体」执行一次吧', 7) + pagerBar('runs', 7); return; }
    const srcMap = { llm: '大模型', template: '模板降级', rule: '规则' };
    tb.innerHTML = runs.map(r => `<tr style="border-bottom:1px solid var(--border);">
      <td style="padding:8px;">${r.id}</td>
      <td style="padding:8px;">${esc(r.agent_name || r.agent_id)}</td>
      <td style="padding:8px;">${esc((r.input || '').slice(0, 24))}</td>
      <td style="padding:8px;">${srcMap[r.source] || esc(r.source || '—')}</td>
      <td style="padding:8px;">${r.duration_ms || 0}ms</td>
      <td style="padding:8px;">${esc(r.created_at || '')}</td>
      <td style="padding:8px;"><button class="btn btn-outline" style="padding:2px 8px;font-size:11px;" onclick="viewAgentRun(${r.id})">详情</button></td>
    </tr>`).join('') + pagerBar('runs', 7);
  } catch (e) { tb.innerHTML = emptyState('加载失败：' + e.message, 7); }
}
async function viewAgentRun(id) {
  try {
    const r = await API.get('/agent-runs/' + id);
    const body = r.result_parsed ? `<pre style="white-space:pre-wrap;background:var(--bg);padding:12px;border-radius:8px;font-size:12px;">${esc(JSON.stringify(r.result_parsed, null, 2))}</pre>` : `<pre style="white-space:pre-wrap;background:var(--bg);padding:12px;border-radius:8px;font-size:12px;">${esc(r.result || '')}</pre>`;
    openGenericModal('运行 #' + id + ' · ' + esc(r.agent_name || r.agent_id), `
      <div style="margin-bottom:8px;">输入：${esc(r.input || '')}</div>
      <div style="margin-bottom:8px;">来源：${esc(r.source)} ｜ 耗时：${r.duration_ms || 0}ms ｜ 时间：${esc(r.created_at || '')}</div>
      ${body}`);
  } catch (e) { showToast(e.message, 'error'); }
}

