// ===== 超管后台：出账与发票 =====
// 仅 superadmin（平台上下文）可访问；所有变更操作写审计。
const express = require('express');
const { authRequired, asyncH, requireRole } = require('../middleware');
const billing = require('../billing');

const router = express.Router();
router.use(authRequired);
router.use(requireRole('superadmin'));

// 账单列表
router.get('/invoices', asyncH(async (req, res) => {
  res.json(await billing.listInvoices({
    tenantId: req.query.tenant_id,
    status: req.query.status,
    dateStart: req.query.date_start,
    dateEnd: req.query.date_end,
    limit: req.query.limit,
    offset: req.query.offset
  }));
}));

// 出账（支持 dry_run 试算）
router.post('/billing/run', asyncH(async (req, res) => {
  const { period_start, period_end, tenant_ids, dry_run, issue } = req.body || {};
  res.json(await billing.runBilling({
    periodStart: period_start,
    periodEnd: period_end,
    tenantIds: Array.isArray(tenant_ids) ? tenant_ids.map(Number) : null,
    dryRun: !!dry_run,
    issue: !!issue,
    createdBy: req.user.id
  }));
}));

// 出账汇总
router.get('/billing/summary', asyncH(async (req, res) => {
  res.json(await billing.invoiceSummary({ month: req.query.month || null }));
}));

// 逾期刷新（issued 且过期 → overdue）
router.post('/billing/refresh-overdue', asyncH(async (req, res) => {
  const updated = await billing.refreshOverdue();
  res.json({ updated });
}));

// 发票详情（明细 + 收款）
router.get('/invoices/:id', asyncH(async (req, res) => {
  res.json(await billing.getInvoiceDetail(req.params.id));
}));

// 开票
router.post('/invoices/:id/issue', asyncH(async (req, res) => {
  res.json({ invoice: await billing.issueInvoice(req.params.id, req.user.id) });
}));

// 作废
router.post('/invoices/:id/void', asyncH(async (req, res) => {
  res.json({ invoice: await billing.voidInvoice(req.params.id, req.user.id) });
}));

// 登记收款
router.post('/invoices/:id/payments', asyncH(async (req, res) => {
  const invoice = await billing.recordPayment(req.params.id, req.body || {}, req.user.id);
  res.status(201).json({ invoice });
}));

// 导出发票文档
router.get('/invoices/:id/export', asyncH(async (req, res) => {
  const doc = await billing.renderInvoiceDocument(req.params.id, req.query.format || 'csv');
  res.setHeader('Content-Type', doc.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
  res.send(doc.body);
}));

// 邮件发送
router.post('/invoices/:id/send', asyncH(async (req, res) => {
  res.json(await billing.sendInvoice(req.params.id, req.user.id));
}));

// 租户账单列表
router.get('/tenants/:id/invoices', asyncH(async (req, res) => {
  res.json(await billing.listInvoices({
    tenantId: req.params.id,
    status: req.query.status,
    limit: req.query.limit,
    offset: req.query.offset
  }));
}));

module.exports = router;
