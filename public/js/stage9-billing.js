// ===== 阶段 9 · 超管账单中心（出账 / 发票 / 收款）=====
// 仅 superadmin 可见。作为全局脚本，加载顺序须早于主脚本。

const INVOICE_STATUS = {
  draft: { label: '草稿', tag: 'tag-info' },
  issued: { label: '已开票', tag: 'tag-primary' },
  paid: { label: '已结清', tag: 'tag-success' },
  void: { label: '已作废', tag: 'tag-danger' },
  overdue: { label: '逾期', tag: 'tag-warning' }
};
const PAY_METHOD_LABEL = { bank: '银行转账', wechat: '微信', alipay: '支付宝', manual: '线下/手工' };

function invStatusTag(s) {
  const m = INVOICE_STATUS[s] || { label: s, tag: '' };
  return `<span class="tag ${m.tag}">${esc(m.label)}</span>`;
}

async function fillTenantSelect(selectId) {
  const sel = $(selectId);
  if (!sel) return;
  try {
    const data = await API.get('/admin/tenants');
    const cur = sel.value;
    sel.innerHTML = '<option value="">全部租户</option>' + (data.tenants || []).map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
    sel.value = cur;
  } catch (_) { /* ignore */ }
}

async function fillTenantMultiSelect(selectId) {
  const sel = $(selectId);
  if (!sel) return;
  try {
    const data = await API.get('/admin/tenants');
    sel.innerHTML = (data.tenants || []).map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  } catch (_) { /* ignore */ }
}

function invMultiValues(selectId) {
  return [...document.querySelectorAll('#' + selectId + ' option:checked')].map(o => Number(o.value));
}

async function initInvoices() {
  if (!$('inv-start').value) { $('inv-start').value = daysAgoStr(90); $('inv-end').value = todayStr(); }
  await fillTenantSelect('inv-tenant');
  pagerReset('invoices');
  loadInvoiceSummary();
  loadInvoices();
}

function invQuery() {
  const p = new URLSearchParams(pagerQuery('invoices'));
  if ($('inv-status').value) p.set('status', $('inv-status').value);
  if ($('inv-tenant').value) p.set('tenant_id', $('inv-tenant').value);
  if ($('inv-start').value) p.set('date_start', $('inv-start').value);
  if ($('inv-end').value) p.set('date_end', $('inv-end').value);
  return p;
}

async function loadInvoices() {
  const tb = $('inv-tbody');
  if (!tb) return;
  pagerRegister('invoices', 30, 'loadInvoices');
  tb.innerHTML = emptyState('加载中…', 9);
  try {
    const data = await API.get('/admin/invoices?' + invQuery().toString());
    const rows = data.invoices || [];
    if (!rows.length) { tb.innerHTML = emptyState('该条件下暂无发票，点击「出账」生成', 9) + pagerBar('invoices', 9); return; }
    tb.innerHTML = rows.map(i => {
      const meta = i.meta_json || {};
      const outstanding = Math.round((Number(i.total) - Number(i.amount_paid)) * 100) / 100;
      return `<tr style="border-bottom:1px solid var(--border);">
        <td style="padding:8px;">${esc(i.invoice_no || ('#' + i.id))}</td>
        <td style="padding:8px;">${esc(meta.tenant_name || ('租户#' + i.tenant_id))}</td>
        <td style="padding:8px;font-size:12px;">${esc(i.period_start)} ~ ${esc(i.period_end)}</td>
        <td style="padding:8px;">${invStatusTag(i.status)}</td>
        <td style="padding:8px;">${i.currency} ${fmtNum(i.total)}</td>
        <td style="padding:8px;">${fmtNum(i.amount_paid)}</td>
        <td style="padding:8px;">${fmtNum(outstanding)}</td>
        <td style="padding:8px;font-size:12px;">${esc(i.due_at || '—')}</td>
        <td style="padding:8px;white-space:nowrap;">
          <button class="btn btn-outline btn-sm" style="padding:2px 8px;font-size:11px;" onclick="viewInvoice(${i.id})">详情</button>
        </td>
      </tr>`;
    }).join('') + pagerBar('invoices', 9);
  } catch (e) { tb.innerHTML = emptyState('加载失败：' + e.message, 9); }
}

async function loadInvoiceSummary() {
  const box = $('inv-summary');
  if (!box) return;
  try {
    const s = await API.get('/admin/billing/summary');
    const cards = [
      { label: '账单数', value: s.count, color: 'm-primary' },
      { label: '累计应收', value: '¥' + fmtNum(s.billed), color: 'm-info' },
      { label: '累计已收', value: '¥' + fmtNum(s.collected), color: 'm-success' },
      { label: '未收', value: '¥' + fmtNum(s.outstanding), color: 'm-accent' },
      { label: '逾期', value: '¥' + fmtNum(s.overdue), color: 'm-primary' }
    ];
    box.innerHTML = cards.map(c => `<div class="metric-card ${c.color}"><div class="metric-label">${esc(c.label)}</div><div class="metric-value">${esc(String(c.value))}</div></div>`).join('');
  } catch (e) { box.innerHTML = `<div style="color:#dc2626;">${esc(e.message)}</div>`; }
}

async function showBillingRunForm() {
  const start = $('inv-start').value || daysAgoStr(30);
  const end = $('inv-end').value || todayStr();
  openGenericModal('出账', `
    <div style="display:flex;flex-direction:column;gap:10px;">
      <div style="display:flex;gap:10px;">
        <div style="flex:1;"><label style="font-size:12px;">周期开始</label><input id="bill-start" type="date" value="${esc(start)}" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;"></div>
        <div style="flex:1;"><label style="font-size:12px;">周期结束</label><input id="bill-end" type="date" value="${esc(end)}" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;"></div>
      </div>
      <div><label style="font-size:12px;">租户范围 <span style="color:var(--text-muted);">（不选=全部活跃租户，可多选）</span></label>
        <select id="bill-tenants" multiple size="5" style="width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px;"></select></div>
      <label style="font-size:12px;"><input type="checkbox" id="bill-issue"> 出账后直接开票</label>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-outline btn-sm" onclick="submitBillingRun(true)">试算预览</button>
        <button class="btn btn-primary btn-sm" onclick="submitBillingRun(false)">正式出账</button>
      </div>
      <div id="bill-result" style="font-size:12px;"></div>
    </div>`);
  await fillTenantMultiSelect('bill-tenants');
}

async function submitBillingRun(dryRun) {
  const box = $('bill-result');
  const body = {
    period_start: $('bill-start').value,
    period_end: $('bill-end').value,
    dry_run: !!dryRun,
    issue: $('bill-issue').checked
  };
  const ids = invMultiValues('bill-tenants');
  if (ids.length) body.tenant_ids = ids;
  if (!body.period_start || !body.period_end) { showToast('请选择出账周期', 'warn'); return; }
  box.innerHTML = dryRun ? '试算中…' : '出账中…';
  try {
    const res = await API.post('/admin/billing/run', body);
    const rows = res.created.map(c => `<tr><td style="padding:4px;">${esc(c.tenant_name || c.tenant_id)}</td><td style="padding:4px;">${c.invoice_no || '（试算）'}</td><td style="padding:4px;text-align:right;">¥${fmtNum(c.total)}</td></tr>`).join('');
    const skipped = res.skipped.length ? `<div style="margin-top:6px;color:var(--text-muted);">跳过 ${res.skipped.length} 个（同周期已存在）</div>` : '';
    box.innerHTML = `<div style="margin-top:8px;">${dryRun ? '试算' : '已生成'} ${res.created.length} 张发票：</div>
      <table style="width:100%;border-collapse:collapse;margin-top:6px;"><tbody>${rows}</tbody></table>${skipped}`;
    if (!dryRun) { showToast('出账完成', 'success'); loadInvoices(); loadInvoiceSummary(); }
  } catch (e) { box.innerHTML = `<span style="color:#dc2626;">${esc(e.message)}</span>`; }
}

async function viewInvoice(id) {
  try {
    const d = await API.get('/admin/invoices/' + id);
    const inv = d.invoice;
    const meta = inv.meta_json || {};
    const items = d.items || [];
    const payments = d.payments || [];
    const outstanding = Math.round((Number(inv.total) - Number(inv.amount_paid)) * 100) / 100;
    const actions = [];
    if (inv.status === 'draft') actions.push(`<button class="btn btn-primary btn-sm" onclick="issueInvoiceById(${id})">开票</button>`);
    if (['draft', 'issued', 'overdue'].includes(inv.status)) actions.push(`<button class="btn btn-outline btn-sm" onclick="voidInvoiceById(${id})">作废</button>`);
    if (inv.status !== 'void' && outstanding > 0) actions.push(`<button class="btn btn-primary btn-sm" onclick="showPaymentForm(${id}, ${outstanding})">登记收款</button>`);
    actions.push(`<button class="btn btn-outline btn-sm" onclick="exportInvoice(${id},'csv')">导出 CSV</button>`);
    actions.push(`<button class="btn btn-outline btn-sm" onclick="exportInvoice(${id},'xls')">导出 Excel</button>`);
    actions.push(`<button class="btn btn-outline btn-sm" onclick="sendInvoiceById(${id})">邮件发送</button>`);
    openGenericModal('发票 ' + (inv.invoice_no || ('#' + inv.id)), `
      <div class="grid grid-2" style="gap:8px;">
        <div>租户：${esc(meta.tenant_name || ('租户#' + inv.tenant_id))}</div>
        <div>状态：${invStatusTag(inv.status)}</div>
        <div>周期：${esc(inv.period_start)} ~ ${esc(inv.period_end)}</div>
        <div>币种：${esc(inv.currency)}</div>
        <div>开票日：${esc(inv.issued_at || '—')}</div>
        <div>到期日：${esc(inv.due_at || '—')}</div>
        <div>小计：${fmtNum(inv.subtotal)}</div>
        <div>税率：${inv.tax_rate}</div>
        <div>税额：${fmtNum(inv.tax_amount)}</div>
        <div>合计：<b>¥${fmtNum(inv.total)}</b></div>
        <div>已收：${fmtNum(inv.amount_paid)}</div>
        <div>未收：${fmtNum(outstanding)}</div>
      </div>
      <div class="flex gap-8" style="margin-top:12px;flex-wrap:wrap;">${actions.join('')}</div>
      <h4 style="margin:14px 0 6px;">明细</h4>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="border-bottom:2px solid var(--border);text-align:left;"><th style="padding:6px;">项目</th><th style="padding:6px;">说明</th><th style="padding:6px;">数量</th><th style="padding:6px;">单价</th><th style="padding:6px;">金额</th></tr></thead>
        <tbody>${items.map(it => `<tr style="border-bottom:1px solid var(--border);">
          <td style="padding:6px;">${esc(it.item_type)}</td><td style="padding:6px;">${esc(it.description || '')}</td>
          <td style="padding:6px;">${it.quantity}</td><td style="padding:6px;">${it.unit_price}</td><td style="padding:6px;">${fmtNum(it.amount)}</td>
        </tr>`).join('') || '<tr><td colspan="5" style="padding:8px;color:var(--text-muted);">无明细</td></tr>'}</tbody>
      </table>
      <h4 style="margin:14px 0 6px;">收款记录</h4>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="border-bottom:2px solid var(--border);text-align:left;"><th style="padding:6px;">金额</th><th style="padding:6px;">方式</th><th style="padding:6px;">参考号</th><th style="padding:6px;">时间</th></tr></thead>
        <tbody>${payments.map(p => `<tr style="border-bottom:1px solid var(--border);">
          <td style="padding:6px;">${fmtNum(p.amount)}</td><td style="padding:6px;">${esc(PAY_METHOD_LABEL[p.method] || p.method)}</td>
          <td style="padding:6px;">${esc(p.reference || '—')}</td><td style="padding:6px;">${esc(p.paid_at || '')}</td>
        </tr>`).join('') || '<tr><td colspan="4" style="padding:8px;color:var(--text-muted);">暂无收款</td></tr>'}</tbody>
      </table>`);
  } catch (e) { showToast(e.message, 'error'); }
}

function issueInvoiceById(id) {
  customConfirm('确认开票？将设置开票日与到期日。', '开票', async () => {
    try { await API.post('/admin/invoices/' + id + '/issue'); showToast('已开票', 'success'); closeModal('modal-generic'); loadInvoices(); loadInvoiceSummary(); }
    catch (e) { showToast(e.message, 'error'); }
  });
}

function voidInvoiceById(id) {
  customConfirm('确认作废该发票？作废后不可恢复。', '作废发票', async () => {
    try { await API.post('/admin/invoices/' + id + '/void'); showToast('已作废', 'success'); closeModal('modal-generic'); loadInvoices(); loadInvoiceSummary(); }
    catch (e) { showToast(e.message, 'error'); }
  }, { icon: '🚫' });
}

function showPaymentForm(id, outstanding) {
  openGenericModal('登记收款 #' + id, `
    <div style="display:flex;flex-direction:column;gap:10px;">
      <div><label style="font-size:12px;">金额（未收 ${fmtNum(outstanding)}）</label>
        <input id="pay-amount" type="number" step="0.01" value="${outstanding}" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;"></div>
      <div><label style="font-size:12px;">方式</label>
        <select id="pay-method" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;">
          <option value="bank">银行转账</option><option value="wechat">微信</option><option value="alipay">支付宝</option><option value="manual">线下/手工</option>
        </select></div>
      <div><label style="font-size:12px;">参考号</label><input id="pay-ref" placeholder="可留空" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;"></div>
      <div><label style="font-size:12px;">备注</label><input id="pay-note" placeholder="可留空" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;"></div>
      <button class="btn btn-primary btn-sm" onclick="submitPayment(${id})">确认收款</button>
    </div>`);
}

async function submitPayment(id) {
  const body = {
    amount: Number($('pay-amount').value),
    method: $('pay-method').value,
    reference: ($('pay-ref').value || '').trim() || null,
    note: ($('pay-note').value || '').trim() || null
  };
  if (!(body.amount > 0)) { showToast('请输入有效金额', 'warn'); return; }
  try {
    await API.post('/admin/invoices/' + id + '/payments', body);
    showToast('收款已登记', 'success');
    closeModal('modal-generic');
    loadInvoices();
    loadInvoiceSummary();
  } catch (e) { showToast(e.message, 'error'); }
}

async function exportInvoice(id, format) {
  try {
    const resp = await authedFetch('/admin/invoices/' + id + '/export?format=' + format);
    if (!resp.ok) throw new Error('导出失败');
    const blob = await resp.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'invoice_' + id + '.' + (format === 'xls' ? 'xls' : 'csv');
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) { showToast(e.message, 'error'); }
}

async function sendInvoiceById(id) {
  customConfirm('将发票信息通过邮件发送给租户联系人，确认？', '发送发票', async () => {
    try { const r = await API.post('/admin/invoices/' + id + '/send'); showToast('已发送至 ' + r.to, 'success'); }
    catch (e) { showToast(e.message, 'error'); }
  }, { icon: '✉️' });
}

async function refreshOverdueInvoices() {
  try {
    const r = await API.post('/admin/billing/refresh-overdue');
    showToast(`已刷新逾期：${r.updated} 张`, 'success');
    loadInvoices();
    loadInvoiceSummary();
  } catch (e) { showToast(e.message, 'error'); }
}
