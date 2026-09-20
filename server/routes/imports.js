// ===== 数据导入路由（CSV 采集器）=====
// 模板下载 / CSV 导入 / 导入批次与报告查询。
const express = require('express');
const multer = require('multer');
const path = require('path');
const { repos } = require('../repositories');
const { requireTenant } = require('../repositories/tenant-context');
const { authRequired, asyncH, requireRole } = require('../middleware');
const csv = require('../integrations/collectors/csv');

const router = express.Router();
router.use(authRequired);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname || '').toLowerCase() !== '.csv') {
      return cb(Object.assign(new Error('仅支持 .csv 文件'), { status: 400 }));
    }
    cb(null, true);
  }
});

const TYPES = csv.types().map(t => t.value);

// 支持的导入类型（供前端选择）
router.get('/stores/import/types', (req, res) => res.json({ types: csv.types() }));

router.get('/stores/import/template', (req, res) => {
  const type = req.query.type || 'daily_report';
  if (!TYPES.includes(type)) return res.status(400).json({ error: `type 须为 ${TYPES.join('/')}` });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="import_${type}_template.csv"`);
  res.send('\uFEFF' + csv.template(type));
});

router.post('/stores/import/csv', requireRole('boss', 'admin'), upload.single('file'), asyncH(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到 CSV 文件' });
  const type = req.query.type || 'auto';
  const result = await csv.importBuffer({
    buffer: req.file.buffer,
    fileName: req.file.originalname,
    type,
    userId: req.user.id
  });
  await repos.adapter.run(
    'INSERT INTO audit_logs (tenant_id, user_id, action, target_type, target_id, detail_json, ip_address) VALUES (?,?,?,?,?,?,?)',
    [requireTenant(), req.user.id, 'import_csv', 'import_batch', String(result.batchId), JSON.stringify({ type: result.type, total: result.total, success: result.success, failed: result.failed }), req.ip]
  );
  res.status(result.status === 'failed' ? 422 : 200).json({ report: result });
}));

router.get('/stores/import/batches', asyncH(async (req, res) => {
  const t = requireTenant();
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
  const batches = await repos.adapter.all(
    'SELECT id, source, file_name, status, total_rows, success_rows, failed_rows, created_at, finished_at FROM import_batches WHERE tenant_id=? ORDER BY id DESC LIMIT ?',
    [t, limit]
  );
  res.json({ batches });
}));

router.get('/stores/import/batches/:id', asyncH(async (req, res) => {
  const t = requireTenant();
  const batch = await repos.adapter.get('SELECT * FROM import_batches WHERE id=? AND tenant_id=?', [req.params.id, t]);
  if (!batch) return res.status(404).json({ error: '导入批次不存在' });
  res.json({
    batch: {
      ...batch,
      errors_json: batch.errors_json ? JSON.parse(batch.errors_json) : [],
      warnings_json: batch.warnings_json ? JSON.parse(batch.warnings_json) : [],
      summary_json: batch.summary_json ? JSON.parse(batch.summary_json) : null
    }
  });
}));

module.exports = router;
