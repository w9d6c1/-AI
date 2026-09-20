const express = require('express');
const path = require('path');
const fs = require('fs');
const { repos } = require('../repositories');
const { requireTenant } = require('../repositories/tenant-context');
const { authRequired, asyncH, rateLimiter } = require('../middleware');
const { generateReport, getAnalyticsOverview, REPORT_TYPES, REPORT_DIR } = require('../report');
const { resolveShopIds, canAccessReport, isAdmin, httpError } = require('../access');
const { dateRange, reportInput } = require('../validation');
const router = express.Router();
router.use(authRequired);

async function logAudit(req, action, id) {
  await repos.adapter.run(
    'INSERT INTO audit_logs (tenant_id,user_id, action, target_type, target_id, ip_address) VALUES (?,?,?,?,?,?)',
    [requireTenant(), req.user.id, action, 'report', String(id), req.ip]
  );
}
async function getReport(req) {
  const r = await repos.adapter.get('SELECT * FROM report_records WHERE id=? AND tenant_id=?', [req.params.id, requireTenant()]);
  if (!r || !(await canAccessReport(req.user, r))) throw httpError(404, '报表不存在或无权访问');
  return r;
}
function reportFile(r) {
  if (!r.file_path) return null;
  const fileName = path.win32.basename(String(r.file_path).replaceAll('/', '\\'));
  if (!/^report_\d+\.(csv|json)$/.test(fileName) && !/^[a-z_]+_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}_\d+\.(csv|json)$/.test(fileName)) {
    throw httpError(400, '报表文件路径无效');
  }
  return path.join(REPORT_DIR, fileName);
}
router.get('/report-types', (req, res) => res.json({ types: Object.entries(REPORT_TYPES).map(([value, label]) => ({ value, label })) }));
router.get('/analytics/overview', asyncH(async (req, res) => {
  const { start, end } = dateRange(req.query.date_start, req.query.date_end);
  const ids = await resolveShopIds(req.user, req.query.shop_ids);
  res.json({ date_range: { start, end }, ...(await getAnalyticsOverview(start, end, JSON.stringify(ids))) });
}));
router.get('/reports', asyncH(async (req, res) => {
  const t = requireTenant();
  const limit = Math.min(100, Math.max(1, Math.trunc(Number(req.query.limit) || 30)));
  const records = isAdmin(req.user)
    ? await repos.adapter.all('SELECT * FROM report_records WHERE tenant_id=? ORDER BY id DESC LIMIT ?', [t, limit])
    : await repos.adapter.all('SELECT * FROM report_records WHERE created_by=? AND tenant_id=? ORDER BY id DESC', [req.user.id, t]);
  const accessible = [];
  for (const r of records) {
    if (await canAccessReport(req.user, r)) accessible.push(r);
    if (accessible.length >= limit) break;
  }
  const reports = accessible.map(r => {
    const { file_path, ...publicRecord } = r;
    return { ...publicRecord, shop_ids: r.shop_ids ? JSON.parse(r.shop_ids) : null };
  });
  res.json({ reports });
}));
router.post('/reports', rateLimiter(60000, 30), asyncH(async (req, res) => {
  const body = req.body || {};
  reportInput(body, REPORT_TYPES);
  const { start, end } = dateRange(body.date_start, body.date_end);
  const ids = await resolveShopIds(req.user, body.shop_ids);
  const info = await repos.adapter.run(
    'INSERT INTO report_records (tenant_id,name,report_type,date_start,date_end,shop_ids,file_format,status,created_by) VALUES (?,?,?,?,?,?,?,?,?)',
    [requireTenant(), body.name.trim(), body.report_type, start, end, JSON.stringify(ids), body.file_format || 'csv', 'pending', req.user.id]
  );
  await logAudit(req, 'report_create', info.lastInsertRowid);
  const result = await generateReport(info.lastInsertRowid);
  res.status(201).json({ id: info.lastInsertRowid, status: 'completed', row_count: result.rowCount, message: '报表生成完成' });
}));
router.get('/reports/:id/download', asyncH(async (req, res) => {
  const r = await getReport(req);
  if (r.status !== 'completed') throw httpError(400, '报表尚未生成完成');
  const file = reportFile(r);
  if (!file || !fs.existsSync(file)) throw httpError(404, '报表文件不存在');
  res.setHeader('Cache-Control', 'no-store');
  res.download(file, path.basename(file));
}));
router.delete('/reports/:id', asyncH(async (req, res) => {
  const r = await getReport(req);
  const file = reportFile(r);
  if (file && fs.existsSync(file)) fs.unlinkSync(file);
  await repos.adapter.run('DELETE FROM report_records WHERE id=? AND tenant_id=?', [r.id, requireTenant()]);
  await logAudit(req, 'report_delete', r.id);
  res.json({ ok: true });
}));
router.get('/report-templates', asyncH(async (req, res) => {
  const t = requireTenant();
  const templates = isAdmin(req.user)
    ? await repos.adapter.all('SELECT * FROM report_templates WHERE tenant_id=? ORDER BY id', [t])
    : await repos.adapter.all('SELECT * FROM report_templates WHERE tenant_id=? AND (created_by=? OR created_by IS NULL) ORDER BY id', [t, req.user.id]);
  res.json({ templates: templates.map(t => ({ ...t, config_json: t.config_json ? JSON.parse(t.config_json) : null, is_default: !!t.is_default })) });
}));
router.post('/report-templates', asyncH(async (req, res) => {
  const body = req.body || {};
  reportInput(body, REPORT_TYPES);
  const t = requireTenant();
  const info = await repos.adapter.run(
    'INSERT INTO report_templates (tenant_id,name,report_type,config_json,is_default,created_by) VALUES (?,?,?,?,?,?)',
    [t, body.name.trim(), body.report_type, body.config ? JSON.stringify(body.config) : null, body.is_default ? 1 : 0, req.user.id]
  );
  res.status(201).json({ template: await repos.adapter.get('SELECT * FROM report_templates WHERE id=? AND tenant_id=?', [info.lastInsertRowid, t]) });
}));
router.delete('/report-templates/:id', asyncH(async (req, res) => {
  const t = requireTenant();
  const tpl = await repos.adapter.get('SELECT * FROM report_templates WHERE id=? AND tenant_id=?', [req.params.id, t]);
  if (!tpl || (!isAdmin(req.user) && tpl.created_by !== req.user.id)) throw httpError(404, '模板不存在或无权访问');
  await repos.adapter.run('DELETE FROM report_templates WHERE id=? AND tenant_id=?', [tpl.id, t]);
  res.json({ ok: true });
}));
module.exports = router;
