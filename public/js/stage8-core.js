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

// ---------- 通用列表分页 ----------
// 各列表在加载时用 pagerRegister(key, limit, 'reloadFnName') 注册；
// 渲染时把 pagerBar(key, colspan) 追加到 tbody 末尾；查询串用 pagerQuery(key)。
const PAGER = {};
function pagerRegister(key, limit, reloadName) {
  if (!PAGER[key]) PAGER[key] = { offset: 0, limit: limit || 50, reloadName };
  return PAGER[key];
}
function pagerGet(key) { return PAGER[key] || { offset: 0, limit: 50, reloadName: null }; }
function pagerReset(key) { const s = PAGER[key]; if (s) s.offset = 0; }
function pagerMove(key, dir) {
  const s = PAGER[key];
  if (!s) return;
  const next = s.offset + dir * s.limit;
  if (next < 0) return;
  s.offset = next;
  if (s.reloadName && typeof window[s.reloadName] === 'function') window[s.reloadName]();
}
function pagerQuery(key) { const s = pagerGet(key); return 'limit=' + s.limit + '&offset=' + s.offset; }
function pagerBar(key, colspan) {
  const s = pagerGet(key);
  const page = Math.floor(s.offset / s.limit) + 1;
  const prevDis = s.offset <= 0 ? 'disabled style="opacity:0.4;cursor:not-allowed;"' : '';
  return `<tr><td colspan="${colspan}" style="padding:10px;text-align:right;border-top:1px solid var(--border);">
    <button class="btn btn-outline btn-sm" ${prevDis} onclick="pagerMove('${key}',-1)">上一页</button>
    <span style="margin:0 8px;font-size:12px;color:var(--text-muted);">第 ${page} 页</span>
    <button class="btn btn-outline btn-sm" onclick="pagerMove('${key}',1)">下一页</button>
  </td></tr>`;
}

