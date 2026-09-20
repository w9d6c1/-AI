// ===== 阶段 8 · 数据查询视图 =====
// 自 public/index.html 拆分（阶段 8 并行开发）。作为全局脚本，加载顺序须早于主脚本。

// ---------- 数据查询 ----------
const DATA_TABS = [
  { k: 'products', label: '商品', key: 'products', cols: [['product_id', '商品ID'], ['title', '标题'], ['category', '类目'], ['price', '价格'], ['status', '状态'], ['platform', '平台'], ['shop_name', '店铺']] },
  { k: 'product-daily', label: '商品日报', key: 'rows', cols: [['report_date', '日期'], ['product_id', '商品ID'], ['visitors', '访客'], ['pay_amount', '支付金额'], ['refund_amount', '退款'], ['platform', '平台'], ['shop_name', '店铺']] },
  { k: 'orders', label: '订单日报', key: 'rows', cols: [['report_date', '日期'], ['order_count', '订单数'], ['payed_order_count', '支付订单'], ['pay_amount', '支付金额'], ['refund_order_count', '退款订单'], ['refund_amount', '退款金额'], ['shop_name', '店铺']] },
  { k: 'refunds', label: '退款日报', key: 'rows', cols: [['report_date', '日期'], ['refund_count', '退款笔数'], ['refund_amount', '退款金额'], ['refund_rate', '退款率'], ['reason_top', '主要原因'], ['shop_name', '店铺']] }
];
let dataTab = 'products';
async function initDataView() {
  const tabs = $('data-tabs');
  if (tabs) tabs.innerHTML = DATA_TABS.map(t => `<button class="filter-btn ${t.k === dataTab ? 'active' : ''}" onclick="selectDataTab('${t.k}')">${t.label}</button>`).join('');
  if (!$('data-start').value) { $('data-start').value = daysAgoStr(7); $('data-end').value = todayStr(); }
  await fillShopSelect('data-shop');
  loadDataView();
}
function selectDataTab(k) {
  dataTab = k;
  document.querySelectorAll('#data-tabs .filter-btn').forEach(b => b.classList.remove('active'));
  const tabs = $('data-tabs');
  if (tabs) tabs.innerHTML = DATA_TABS.map(t => `<button class="filter-btn ${t.k === dataTab ? 'active' : ''}" onclick="selectDataTab('${t.k}')">${t.label}</button>`).join('');
  loadDataView();
}
async function loadDataView() {
  const tab = DATA_TABS.find(t => t.k === dataTab);
  const thead = $('data-thead');
  const tbody = $('data-tbody');
  if (!tab || !thead || !tbody) return;
  thead.innerHTML = '<tr style="border-bottom:2px solid var(--border);text-align:left;">' + tab.cols.map(c => `<th style="padding:8px;">${c[1]}</th>`).join('') + '</tr>';
  tbody.innerHTML = emptyState('查询中…', tab.cols.length);
  const p = new URLSearchParams();
  if ($('data-platform').value) p.set('platform', $('data-platform').value);
  if ($('data-shop').value) p.set('shop_id', $('data-shop').value);
  if ($('data-q').value && dataTab === 'products') p.set('q', $('data-q').value);
  if ($('data-start').value && dataTab !== 'products') { p.set('date_start', $('data-start').value); p.set('date_end', $('data-end').value); }
  try {
    const data = await API.get('/stores/' + tab.k + '?' + p.toString());
    const rows = data[tab.key] || [];
    if (!rows.length) { tbody.innerHTML = emptyState('暂无数据，可前往「数据导入」上传 CSV', tab.cols.length); return; }
    tbody.innerHTML = rows.map(r => '<tr style="border-bottom:1px solid var(--border);">' + tab.cols.map(c => {
      const v = r[c[0]];
      return `<td style="padding:8px;">${v === null || v === undefined ? '—' : esc(typeof v === 'number' ? String(Math.round(v * 10000) / 10000) : v)}</td>`;
    }).join('') + '</tr>').join('');
  } catch (e) { tbody.innerHTML = emptyState('加载失败：' + e.message, tab.cols.length); }
}

