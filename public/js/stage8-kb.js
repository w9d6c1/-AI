// ===== 阶段 8 · 知识库检索视图（RAG 命中片段）=====
// 作为全局脚本，加载顺序须早于主脚本。

async function runKbSearch() {
  const box = $('kb-search-results');
  if (!box) return;
  const q = ($('kb-query').value || '').trim();
  if (!q) { showToast('请输入检索内容', 'warn'); return; }
  box.innerHTML = '<div style="color:var(--text-muted);">检索中…</div>';
  try {
    const data = await API.post('/kb-search', { query: q, top_k: 5 });
    const results = data.results || [];
    if (!results.length) { box.innerHTML = '<div style="color:var(--text-muted);">未命中相关内容</div>'; return; }
    box.innerHTML = results.map(r => `
      <div style="padding:8px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;">
        <div style="font-size:11px;color:var(--text-muted);">文档 #${r.doc_id} · 片段 ${r.chunk_index} · 相关度 ${r.score}</div>
        <div style="margin-top:4px;line-height:1.6;">${esc(r.content)}</div>
      </div>`).join('');
  } catch (e) {
    box.innerHTML = `<span style="color:#dc2626;">${esc(e.message)}</span>`;
  }
}
