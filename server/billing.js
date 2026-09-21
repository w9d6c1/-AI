// ===== 出账与发票服务 =====
// 出账（billing run）→ 发票（invoice）→ 收款（payment）→ 汇总/导出/发送。
// 计费口径：订阅费 = tenants.price_per_month（年付×12）+ 用量费 = 周期内 ai_usage 成本 × BILLING_USAGE_MARKUP；税 = 小计 × tax_rate。
const { repos } = require('./repositories');
const { requireTenant, runWithTenant, runAsPlatform } = require('./repositories/tenant-context');
const { nowLocal, todayLocal } = require('./util');
const { toSpreadsheetML } = require('./xlsx');
const { audit } = require('./audit');
const { httpError } = require('./access');

const round2 = v => Math.round(Number(v || 0) * 100) / 100;
const PAY_METHODS = ['bank', 'wechat', 'alipay', 'manual'];

function billingConfig() {
  return {
    currency: process.env.BILLING_CURRENCY || 'CNY',
    taxRate: Number(process.env.BILLING_TAX_RATE || 0) || 0,
    usageMarkup: Number(process.env.BILLING_USAGE_MARKUP || 1) || 1,
    dueDays: Number(process.env.BILLING_DUE_DAYS || 15) || 15,
    autoIssue: String(process.env.BILLING_AUTO_ISSUE || 'false') === 'true',
    company: {
      name: process.env.BILLING_COMPANY_NAME || '智营 AI 电商智能经营平台',
      taxId: process.env.BILLING_COMPANY_TAX_ID || '',
      address: process.env.BILLING_COMPANY_ADDRESS || '',
      contact: process.env.BILLING_COMPANY_CONTACT || ''
    }
  };
}

const periodEndTs = end => end + ' 23:59:59';

// 周期内 AI 用量（ai_usage）
async function periodUsage(tenantId, periodStart, periodEnd) {
  const row = (await repos.adapter.get(
    `SELECT COUNT(*) calls, COALESCE(SUM(tokens_in),0) tokens_in, COALESCE(SUM(tokens_out),0) tokens_out, COALESCE(SUM(cost),0) cost
     FROM ai_usage WHERE tenant_id=? AND created_at >= ? AND created_at <= ?`,
    [tenantId, periodStart, periodEndTs(periodEnd)]
  )) || {};
  return { calls: Number(row.calls || 0), tokens_in: Number(row.tokens_in || 0), tokens_out: Number(row.tokens_out || 0), cost: round2(row.cost) };
}

// 构建发票明细（订阅费 + 用量费 + 税）
async function buildInvoiceItems(tenant, periodStart, periodEnd) {
  const cfg = billingConfig();
  const usage = await periodUsage(tenant.id, periodStart, periodEnd);
  const items = [];

  const price = Number(tenant.price_per_month || 0);
  if (price > 0) {
    const yearly = tenant.billing_cycle === 'yearly';
    const qty = yearly ? 12 : 1;
    items.push({
      item_type: 'subscription',
      description: `${tenant.plan || 'trial'} 订阅费（${yearly ? '年付' : '月付'}）`,
      quantity: qty,
      unit_price: round2(price),
      amount: round2(price * qty),
      meta_json: { plan: tenant.plan || null, cycle: tenant.billing_cycle || 'monthly' }
    });
  }

  const usageAmount = round2(usage.cost * cfg.usageMarkup);
  if (usageAmount > 0) {
    items.push({
      item_type: 'ai_cost',
      description: `AI 用量费（${usage.calls} 次调用 / ${usage.tokens_in + usage.tokens_out} tokens）`,
      quantity: usage.calls,
      unit_price: cfg.usageMarkup,
      amount: usageAmount,
      meta_json: { tokens_in: usage.tokens_in, tokens_out: usage.tokens_out, raw_cost: usage.cost, markup: cfg.usageMarkup }
    });
  }

  const subtotal = round2(items.reduce((s, i) => s + i.amount, 0));
  const taxRate = Number(tenant.tax_rate || 0) || cfg.taxRate || 0;
  const taxAmount = round2(subtotal * taxRate);
  return { items, usage, subtotal, taxRate, taxAmount, total: round2(subtotal + taxAmount) };
}

// 发票号：INV-YYYYMM-NNNN（平台上下文自增）
async function nextInvoiceNo(monthKeyStr) {
  const prefix = 'INV-' + monthKeyStr + '-';
  const row = await repos.adapter.get('SELECT invoice_no FROM invoices WHERE invoice_no LIKE ? ORDER BY invoice_no DESC LIMIT 1', [prefix + '%']);
  let seq = 1;
  if (row && row.invoice_no) {
    const n = Number(String(row.invoice_no).slice(prefix.length));
    if (Number.isFinite(n)) seq = n + 1;
  }
  return prefix + String(seq).padStart(4, '0');
}

async function loadInvoiceAdmin(id) {
  const inv = await runAsPlatform(() => repos.adapter.get('SELECT * FROM invoices WHERE id=?', [Number(id)]));
  if (!inv) throw httpError(404, '发票不存在');
  return inv;
}

function getInvoice(tenantId, id) {
  return repos.adapter.get('SELECT * FROM invoices WHERE id=? AND tenant_id=?', [id, tenantId]);
}

// 出账：为租户生成发票（幂等：同周期非作废发票存在则跳过）
async function runBilling({ periodStart, periodEnd, tenantIds = null, dryRun = false, issue = false, createdBy = null } = {}) {
  if (!periodStart || !periodEnd) throw httpError(400, '缺少出账周期（period_start / period_end）');
  if (periodStart > periodEnd) throw httpError(400, '周期起止非法');
  const cfg = billingConfig();
  const monthKeyStr = String(periodStart).slice(0, 7).replace('-', '');

  const tenants = await runAsPlatform(() => {
    if (Array.isArray(tenantIds) && tenantIds.length) {
      const ph = tenantIds.map(() => '?').join(',');
      return repos.adapter.all(`SELECT * FROM tenants WHERE id IN (${ph})`, tenantIds);
    }
    return repos.adapter.all("SELECT * FROM tenants WHERE status='active'");
  });

  const created = [];
  const skipped = [];
  for (const tenant of tenants) {
    const existing = await runWithTenant(tenant.id, () => repos.adapter.get(
      "SELECT id, invoice_no, status FROM invoices WHERE tenant_id=? AND period_start=? AND period_end=? AND status<>'void'",
      [tenant.id, periodStart, periodEnd]
    ));
    if (existing) { skipped.push({ tenant_id: tenant.id, tenant_name: tenant.name, reason: 'exists', invoice_id: existing.id, invoice_no: existing.invoice_no }); continue; }

    const built = await runWithTenant(tenant.id, () => buildInvoiceItems(tenant, periodStart, periodEnd));
    if (dryRun) {
      created.push({
        tenant_id: tenant.id, tenant_name: tenant.name, period_start: periodStart, period_end: periodEnd,
        subtotal: built.subtotal, tax_rate: built.taxRate, tax_amount: built.taxAmount, total: built.total,
        items: built.items.map(i => ({ item_type: i.item_type, description: i.description, amount: i.amount }))
      });
      continue;
    }

    const invoiceId = await runAsPlatform(() => repos.tx(async () => {
      const invoiceNo = await nextInvoiceNo(monthKeyStr);
      const info = await repos.adapter.run(
        `INSERT INTO invoices (tenant_id, invoice_no, period_start, period_end, billing_cycle, status, currency, subtotal, tax_rate, tax_amount, total, amount_paid, meta_json, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [tenant.id, invoiceNo, periodStart, periodEnd, tenant.billing_cycle || 'monthly', 'draft', cfg.currency,
          built.subtotal, built.taxRate, built.taxAmount, built.total, 0,
          JSON.stringify({ tenant_name: tenant.name, plan: tenant.plan || null, contact_name: tenant.contact_name || null, contact_email: tenant.contact_email || null }),
          createdBy]
      );
      const id = info.lastInsertRowid;
      for (const it of built.items) {
        await repos.adapter.run(
          'INSERT INTO invoice_items (tenant_id, invoice_id, item_type, description, quantity, unit_price, amount, meta_json) VALUES (?,?,?,?,?,?,?,?)',
          [tenant.id, id, it.item_type, it.description, it.quantity, it.unit_price, it.amount, it.meta_json ? JSON.stringify(it.meta_json) : null]
        );
      }
      return id;
    }));
    await audit({ tenantId: tenant.id, userId: createdBy, action: 'invoice_create', targetType: 'invoice', targetId: invoiceId, detail: { total: built.total } });
    if (issue) await issueInvoice(invoiceId, createdBy);
    created.push(await runWithTenant(tenant.id, () => getInvoice(tenant.id, invoiceId)));
  }

  return { period: { start: periodStart, end: periodEnd }, dry_run: !!dryRun, created, skipped };
}

async function issueInvoice(id, userId = null) {
  const inv = await loadInvoiceAdmin(id);
  if (inv.status !== 'draft') throw httpError(400, '仅草稿状态的发票可开票');
  const cfg = billingConfig();
  const issuedAt = nowLocal();
  const dueAt = nowLocal(new Date(Date.now() + cfg.dueDays * 86400000));
  await runWithTenant(inv.tenant_id, () => repos.adapter.run(
    'UPDATE invoices SET status=?, issued_at=?, due_at=?, updated_at=? WHERE id=? AND tenant_id=?',
    ['issued', issuedAt, dueAt, issuedAt, inv.id, inv.tenant_id]
  ));
  await audit({ tenantId: inv.tenant_id, userId, action: 'invoice_issue', targetType: 'invoice', targetId: inv.id, detail: { due_at: dueAt } });
  return runWithTenant(inv.tenant_id, () => getInvoice(inv.tenant_id, inv.id));
}

async function voidInvoice(id, userId = null) {
  const inv = await loadInvoiceAdmin(id);
  if (!['draft', 'issued', 'overdue'].includes(inv.status)) throw httpError(400, '当前状态不可作废');
  await runWithTenant(inv.tenant_id, () => repos.adapter.run(
    'UPDATE invoices SET status=?, updated_at=? WHERE id=? AND tenant_id=?',
    ['void', nowLocal(), inv.id, inv.tenant_id]
  ));
  await audit({ tenantId: inv.tenant_id, userId, action: 'invoice_void', targetType: 'invoice', targetId: inv.id });
  return runWithTenant(inv.tenant_id, () => getInvoice(inv.tenant_id, inv.id));
}

async function recordPayment(id, payload = {}, userId = null) {
  const inv = await loadInvoiceAdmin(id);
  if (inv.status === 'void') throw httpError(400, '作废发票不可收款');
  const amount = round2(payload.amount);
  if (!(amount > 0)) throw httpError(400, '收款金额须大于 0');
  const method = PAY_METHODS.includes(payload.method) ? payload.method : 'manual';
  const paidAt = payload.paid_at || nowLocal();

  await runWithTenant(inv.tenant_id, () => repos.tx(async () => {
    await repos.adapter.run(
      'INSERT INTO payments (tenant_id, invoice_id, amount, method, reference, paid_at, note, created_by) VALUES (?,?,?,?,?,?,?,?)',
      [inv.tenant_id, inv.id, amount, method, payload.reference || null, paidAt, payload.note || null, userId]
    );
    const sum = (await repos.adapter.get('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE invoice_id=? AND tenant_id=?', [inv.id, inv.tenant_id])) || {};
    const paid = round2(sum.s);
    const settled = paid >= round2(inv.total) - 1e-9;
    await repos.adapter.run(
      'UPDATE invoices SET amount_paid=?, status=?, paid_at=?, updated_at=? WHERE id=? AND tenant_id=?',
      [paid, settled ? 'paid' : inv.status, settled ? paidAt : inv.paid_at, nowLocal(), inv.id, inv.tenant_id]
    );
  }));
  await audit({ tenantId: inv.tenant_id, userId, action: 'invoice_payment', targetType: 'invoice', targetId: inv.id, detail: { amount, method } });
  return runWithTenant(inv.tenant_id, () => getInvoice(inv.tenant_id, inv.id));
}

// 逾期刷新：issued 且已过到期日 → overdue
async function refreshOverdue() {
  const today = todayLocal();
  const rows = await runAsPlatform(() => repos.adapter.all(
    "SELECT id, tenant_id FROM invoices WHERE status='issued' AND due_at IS NOT NULL AND due_at < ?", [today]
  ));
  for (const r of rows) {
    await runWithTenant(r.tenant_id, () => repos.adapter.run(
      "UPDATE invoices SET status='overdue', updated_at=? WHERE id=? AND tenant_id=?", [nowLocal(), r.id, r.tenant_id]
    ));
  }
  return rows.length;
}

async function invoiceSummary({ month = null } = {}) {
  return runAsPlatform(async () => {
    const where = [];
    const params = [];
    if (month) { where.push('period_start LIKE ?'); params.push(month + '%'); }
    const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const byStatus = await repos.adapter.all(`SELECT status, COUNT(*) c, COALESCE(SUM(total),0) total, COALESCE(SUM(amount_paid),0) paid FROM invoices${clause} GROUP BY status`, params);
    const row = (await repos.adapter.get(
      `SELECT COUNT(*) cnt,
        COALESCE(SUM(CASE WHEN status<>'void' THEN total ELSE 0 END),0) billed,
        COALESCE(SUM(CASE WHEN status<>'void' THEN amount_paid ELSE 0 END),0) collected,
        COALESCE(SUM(CASE WHEN status='overdue' THEN total ELSE 0 END),0) overdue
       FROM invoices${clause}`, params
    )) || {};
    const by = {};
    for (const r of byStatus) by[r.status] = { count: Number(r.c), total: round2(r.total), paid: round2(r.paid) };
    return {
      month,
      count: Number(row.cnt || 0),
      billed: round2(row.billed),
      collected: round2(row.collected),
      outstanding: round2(Number(row.billed || 0) - Number(row.collected || 0)),
      overdue: round2(row.overdue),
      by_status: by
    };
  });
}

// 发票文档（CSV / Excel）：公司信息 + 租户 + 明细 + 合计
async function renderInvoiceDocument(id, format = 'csv') {
  const inv = await loadInvoiceAdmin(id);
  const items = await runWithTenant(inv.tenant_id, () => repos.adapter.all(
    'SELECT * FROM invoice_items WHERE invoice_id=? AND tenant_id=? ORDER BY id', [inv.id, inv.tenant_id]
  ));
  const meta = inv.meta_json ? JSON.parse(inv.meta_json) : {};
  const cfg = billingConfig();
  const co = cfg.company;
  const fmt = String(format || 'csv').toLowerCase();
  const tenantName = meta.tenant_name || ('#' + inv.tenant_id);
  const period = inv.period_start + ' ~ ' + inv.period_end;
  const outstanding = round2(Number(inv.total) - Number(inv.amount_paid));

  if (fmt === 'xls' || fmt === 'excel') {
    const columns = ['发票号', '平台', '租户', '周期', '项目', '说明', '数量', '单价', '金额', '状态'];
    const data = items.map(it => ({
      发票号: inv.invoice_no, 平台: co.name, 租户: tenantName, 周期: period,
      项目: it.item_type, 说明: it.description, 数量: it.quantity, 单价: it.unit_price, 金额: it.amount, 状态: inv.status
    }));
    data.push({ 发票号: inv.invoice_no, 说明: '小计', 金额: inv.subtotal });
    data.push({ 发票号: inv.invoice_no, 说明: `税额（${inv.tax_rate}）`, 金额: inv.tax_amount });
    data.push({ 发票号: inv.invoice_no, 说明: '合计', 金额: inv.total });
    data.push({ 发票号: inv.invoice_no, 说明: '已收', 金额: inv.amount_paid });
    data.push({ 发票号: inv.invoice_no, 说明: '未收', 金额: outstanding });
    return {
      filename: (inv.invoice_no || ('invoice_' + inv.id)) + '.xls',
      contentType: 'application/vnd.ms-excel; charset=utf-8',
      body: toSpreadsheetML('发票', columns, data)
    };
  }

  const esc = v => {
    const s = v == null ? '' : String(v);
    return (s.includes(',') || s.includes('"') || /[\r\n]/.test(s)) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [];
  const push = (...cells) => rows.push(cells.map(esc).join(','));
  push('发票号', inv.invoice_no || '');
  push('平台', co.name);
  push('纳税人识别号', co.taxId);
  push('地址', co.address);
  push('联系方式', co.contact);
  push('租户', tenantName);
  push('联系人', meta.contact_name || '');
  push('联系邮箱', meta.contact_email || '');
  push('周期', period);
  push('币种', inv.currency);
  push('状态', inv.status);
  push('开票日', inv.issued_at || '');
  push('到期日', inv.due_at || '');
  push('');
  push('项目', '说明', '数量', '单价', '金额');
  for (const it of items) push(it.item_type, it.description, it.quantity, it.unit_price, it.amount);
  push('');
  push('小计', '', '', '', inv.subtotal);
  push('税率', '', '', '', inv.tax_rate);
  push('税额', '', '', '', inv.tax_amount);
  push('合计', '', '', '', inv.total);
  push('已收', '', '', '', inv.amount_paid);
  push('未收', '', '', '', outstanding);
  return {
    filename: (inv.invoice_no || ('invoice_' + inv.id)) + '.csv',
    contentType: 'text/csv; charset=utf-8',
    body: '\uFEFF' + rows.join('\n')
  };
}

async function sendInvoice(id, userId = null) {
  const inv = await loadInvoiceAdmin(id);
  const meta = inv.meta_json ? JSON.parse(inv.meta_json) : {};
  const to = meta.contact_email;
  if (!to) throw httpError(400, '租户未配置联系邮箱，无法发送');
  const cfg = billingConfig();
  const text = `【${cfg.company.name}】发票 ${inv.invoice_no}\n租户：${meta.tenant_name || inv.tenant_id}\n周期：${inv.period_start} ~ ${inv.period_end}\n金额：${inv.currency} ${inv.total}\n到期：${inv.due_at || '—'}\n状态：${inv.status}`;
  const { sendMessage } = require('./notifier');
  const res = await sendMessage(inv.tenant_id, { to, subject: `发票 ${inv.invoice_no}`, text });
  await audit({ tenantId: inv.tenant_id, userId, action: 'invoice_send', targetType: 'invoice', targetId: inv.id, detail: { to } });
  return res;
}

// 账单列表（平台级，超管）
async function listInvoices({ tenantId = null, status = null, dateStart = null, dateEnd = null, limit = 50, offset = 0 } = {}) {
  return runAsPlatform(async () => {
    const where = [];
    const params = [];
    if (tenantId) { where.push('tenant_id=?'); params.push(Number(tenantId)); }
    if (status) { where.push('status=?'); params.push(status); }
    if (dateStart) { where.push('period_start >= ?'); params.push(dateStart); }
    if (dateEnd) { where.push('period_start <= ?'); params.push(dateEnd); }
    const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const lim = Math.min(200, Math.max(1, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);
    const invoices = await repos.adapter.all(`SELECT * FROM invoices${clause} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, lim, off]);
    return { invoices: invoices.map(i => ({ ...i, meta_json: i.meta_json ? JSON.parse(i.meta_json) : null })), limit: lim, offset: off };
  });
}

async function getInvoiceDetail(id) {
  const inv = await loadInvoiceAdmin(id);
  const [items, payments] = await runWithTenant(inv.tenant_id, () => Promise.all([
    repos.adapter.all('SELECT * FROM invoice_items WHERE invoice_id=? AND tenant_id=? ORDER BY id', [inv.id, inv.tenant_id]),
    repos.adapter.all('SELECT * FROM payments WHERE invoice_id=? AND tenant_id=? ORDER BY id', [inv.id, inv.tenant_id])
  ]));
  return { invoice: { ...inv, meta_json: inv.meta_json ? JSON.parse(inv.meta_json) : null }, items, payments };
}

module.exports = {
  billingConfig, periodUsage, buildInvoiceItems, runBilling,
  issueInvoice, voidInvoice, recordPayment, refreshOverdue,
  invoiceSummary, renderInvoiceDocument, sendInvoice,
  listInvoices, getInvoiceDetail
};
