// ===== 阶段 8 公共：空态 / 通用弹窗 / 日期与数字格式化 / 店铺下拉 / 带鉴权 fetch =====
// 自 public/index.html 拆分（阶段 8 并行开发）。作为全局脚本，加载顺序须早于主脚本。

// ===================== 阶段 8：新增视图逻辑 =====================
function emptyState(text, colspan) {
  return `<tr><td colspan="${colspan}" style="padding:28px;text-align:center;color:var(--text-muted);">
    <div style="font-size:22px;margin-bottom:6px;">📭</div>${esc(text)}</td></tr>`;
}
function openGenericModal(title, html) {
  $('generic-title').textContent = title;
  $('generic-body').innerHTML = html;
  openModal('modal-generic');
}
function todayStr() { return new Date().toISOString().slice(0, 10); }
function daysAgoStr(n) { const d = new Date(Date.now() - n * 86400000); return d.toISOString().slice(0, 10); }
function fmtNum(v) { return v === null || v === undefined ? '—' : Number(v).toLocaleString('zh-CN'); }
async function fillShopSelect(selectId) {
  const sel = $(selectId);
  if (!sel) return;
  try {
    const data = await API.get('/shops');
    const cur = sel.value;
    sel.innerHTML = '<option value="">全部店铺</option>' + (data.shops || []).map(s => `<option value="${s.id}">${esc(s.shop_name)}</option>`).join('');
    sel.value = cur;
  } catch (_) { /* ignore */ }
}
async function authedFetch(path, opts = {}) {
  const token = localStorage.getItem('zy_token');
  const headers = Object.assign({}, opts.headers || {});
  if (token) headers['Authorization'] = 'Bearer ' + token;
  return fetch('/api' + path, { ...opts, headers });
}

