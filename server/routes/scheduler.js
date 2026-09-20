// ===== 定时采集调度路由 =====
const express = require('express');
const { repos } = require('../repositories');
const { requireTenant } = require('../repositories/tenant-context');
const { dayPrefix } = require('../repositories/sql');
const { authRequired, asyncH, requireRole } = require('../middleware');
const { runSchedule, calcNextRun } = require('../scheduler');
const { todayLocal } = require('../util');

const router = express.Router();
router.use(authRequired);
router.use('/schedules', requireRole('boss', 'admin'));

const ADMIN_ROLES = ['boss', 'admin'];

async function logAudit(userId, action, targetId, detail, ip) {
  await repos.adapter.run(
    'INSERT INTO audit_logs (tenant_id,user_id, action, target_type, target_id, detail_json, ip_address) VALUES (?,?,?,?,?,?,?)',
    [requireTenant(), userId || null, action, 'schedule', targetId ? String(targetId) : null, detail ? JSON.stringify(detail) : null, ip || null]
  );
}

function shape(s) {
  return { ...s, target_ids: s.target_ids ? JSON.parse(s.target_ids) : [], auto_suggest: !!s.auto_suggest, enabled: !!s.enabled };
}

router.get('/schedules', asyncH(async (req, res) => {
  const schedules = await repos.adapter.all('SELECT * FROM collection_schedules WHERE tenant_id=? ORDER BY enabled DESC, id', [requireTenant()]);
  res.json({ schedules: schedules.map(shape) });
}));

router.post('/schedules', asyncH(async (req, res) => {
  if (!ADMIN_ROLES.includes(req.user.role || 'member')) return res.status(403).json({ error: '仅管理员可创建调度' });
  const t = requireTenant();
  const { name, schedule_type, run_time, week_day, target_type, target_ids, auto_suggest, max_retries, retry_delay_min } = req.body;
  if (!name || !run_time) return res.status(400).json({ error: '名称和执行时间不能为空' });
  if (!/^\d{2}:\d{2}$/.test(run_time)) return res.status(400).json({ error: '时间格式需为 HH:MM' });
  if (schedule_type === 'weekly' && (week_day == null || week_day < 0 || week_day > 6))
    return res.status(400).json({ error: 'weekly 类型需指定 week_day (0-6)' });

  const now = new Date().toLocaleString('zh-CN');
  const info = await repos.adapter.run(`INSERT INTO collection_schedules
    (tenant_id, name, schedule_type, run_time, week_day, target_type, target_ids, enabled, auto_suggest, max_retries, retry_delay_min, next_run_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,1,?,?,?,?,?,?)`,
    [t, name, schedule_type || 'daily', run_time, week_day ?? null, target_type || 'all', target_ids ? JSON.stringify(target_ids) : null, auto_suggest ? 1 : 0, max_retries ?? 2, retry_delay_min ?? 10, null, now, now]);

  const schedule = await repos.adapter.get('SELECT * FROM collection_schedules WHERE id=? AND tenant_id=?', [info.lastInsertRowid, t]);
  await repos.adapter.run('UPDATE collection_schedules SET next_run_at=? WHERE id=? AND tenant_id=?', [calcNextRun(schedule), schedule.id, t]);

  await logAudit(req.user.id, 'schedule_create', schedule.id, { name, schedule_type, run_time }, req.ip);
  res.json({ schedule: shape({ ...schedule, next_run_at: calcNextRun(schedule) }) });
}));

router.put('/schedules/:id', asyncH(async (req, res) => {
  if (!ADMIN_ROLES.includes(req.user.role || 'member')) return res.status(403).json({ error: '仅管理员可修改调度' });
  const t = requireTenant();
  const s = await repos.adapter.get('SELECT * FROM collection_schedules WHERE id=? AND tenant_id=?', [req.params.id, t]);
  if (!s) return res.status(404).json({ error: '调度不存在' });

  const { name, schedule_type, run_time, week_day, target_type, target_ids, auto_suggest, max_retries, retry_delay_min } = req.body;
  if (run_time && !/^\d{2}:\d{2}$/.test(run_time)) return res.status(400).json({ error: '时间格式需为 HH:MM' });

  const now = new Date().toLocaleString('zh-CN');
  await repos.adapter.run(`UPDATE collection_schedules SET
    name=?, schedule_type=?, run_time=?, week_day=?, target_type=?, target_ids=?,
    auto_suggest=?, max_retries=?, retry_delay_min=?, updated_at=? WHERE id=? AND tenant_id=?`,
    [name ?? s.name, schedule_type ?? s.schedule_type, run_time ?? s.run_time,
      week_day !== undefined ? week_day : s.week_day, target_type ?? s.target_type,
      target_ids !== undefined ? (target_ids ? JSON.stringify(target_ids) : null) : s.target_ids,
      auto_suggest !== undefined ? (auto_suggest ? 1 : 0) : s.auto_suggest,
      max_retries ?? s.max_retries, retry_delay_min ?? s.retry_delay_min, now, req.params.id, t]);

  const updated = await repos.adapter.get('SELECT * FROM collection_schedules WHERE id=? AND tenant_id=?', [req.params.id, t]);
  await repos.adapter.run('UPDATE collection_schedules SET next_run_at=? WHERE id=? AND tenant_id=?', [calcNextRun(updated), updated.id, t]);

  await logAudit(req.user.id, 'schedule_update', req.params.id, { name, run_time }, req.ip);
  res.json({ schedule: shape({ ...updated, next_run_at: calcNextRun(updated) }) });
}));

router.patch('/schedules/:id/toggle', asyncH(async (req, res) => {
  if (!ADMIN_ROLES.includes(req.user.role || 'member')) return res.status(403).json({ error: '仅管理员可操作' });
  const t = requireTenant();
  const s = await repos.adapter.get('SELECT * FROM collection_schedules WHERE id=? AND tenant_id=?', [req.params.id, t]);
  if (!s) return res.status(404).json({ error: '调度不存在' });
  const newEnabled = s.enabled ? 0 : 1;
  const now = new Date().toLocaleString('zh-CN');
  const nextRun = newEnabled ? calcNextRun(s) : null;
  await repos.adapter.run('UPDATE collection_schedules SET enabled=?, next_run_at=?, updated_at=? WHERE id=? AND tenant_id=?', [newEnabled, nextRun, now, req.params.id, t]);
  await logAudit(req.user.id, 'schedule_toggle', req.params.id, { enabled: !!newEnabled }, req.ip);
  res.json({ ok: true, enabled: !!newEnabled, next_run_at: nextRun });
}));

router.delete('/schedules/:id', asyncH(async (req, res) => {
  if (!ADMIN_ROLES.includes(req.user.role || 'member')) return res.status(403).json({ error: '仅管理员可删除调度' });
  const t = requireTenant();
  await repos.adapter.run('DELETE FROM collection_schedules WHERE id=? AND tenant_id=?', [req.params.id, t]);
  await logAudit(req.user.id, 'schedule_delete', req.params.id, null, req.ip);
  res.json({ ok: true });
}));

router.post('/schedules/:id/run', asyncH(async (req, res) => {
  if (!ADMIN_ROLES.includes(req.user.role || 'member')) return res.status(403).json({ error: '仅管理员可手动触发' });
  const t = requireTenant();
  const s = await repos.adapter.get('SELECT * FROM collection_schedules WHERE id=? AND tenant_id=?', [req.params.id, t]);
  if (!s) return res.status(404).json({ error: '调度不存在' });
  const result = await runSchedule(s.id);
  await logAudit(req.user.id, 'schedule_manual_run', s.id, { result }, req.ip);
  res.json({ message: '调度执行完成', ...result });
}));

router.get('/schedules/:id/runs', asyncH(async (req, res) => {
  const limit = Math.min(100, Number(req.query.limit) || 20);
  const runs = await repos.adapter.all('SELECT * FROM schedule_runs WHERE schedule_id=? AND tenant_id=? ORDER BY run_at DESC LIMIT ?', [req.params.id, requireTenant(), limit]);
  res.json({ runs });
}));

router.get('/schedules/runs/recent', asyncH(async (req, res) => {
  const t = requireTenant();
  const limit = Math.min(200, Number(req.query.limit) || 50);
  const runs = await repos.adapter.all(`
    SELECT sr.*, cs.name as schedule_name
    FROM schedule_runs sr
    JOIN collection_schedules cs ON sr.schedule_id=cs.id AND cs.tenant_id=sr.tenant_id
    WHERE sr.tenant_id=?
    ORDER BY sr.run_at DESC LIMIT ?
  `, [t, limit]);
  res.json({ runs });
}));

router.get('/schedules/status', asyncH(async (req, res) => {
  const t = requireTenant();
  const total = Number((await repos.adapter.get('SELECT COUNT(*) as c FROM collection_schedules WHERE tenant_id=?', [t])).c);
  const enabled = Number((await repos.adapter.get('SELECT COUNT(*) as c FROM collection_schedules WHERE tenant_id=? AND enabled=1', [t])).c);
  const todayRuns = Number((await repos.adapter.get('SELECT COUNT(*) as c FROM schedule_runs WHERE tenant_id=? AND run_at LIKE ?', [t, dayPrefix(todayLocal())])).c);
  const runningCount = Number((await repos.adapter.get("SELECT COUNT(*) as c FROM schedule_runs WHERE tenant_id=? AND status='running'", [t])).c);
  const upcoming = await repos.adapter.all("SELECT id, name, run_time, schedule_type, week_day, next_run_at FROM collection_schedules WHERE tenant_id=? AND enabled=1 AND next_run_at IS NOT NULL ORDER BY next_run_at LIMIT 5", [t]);
  res.json({ total, enabled, today_runs: todayRuns, running: runningCount, upcoming });
}));

module.exports = router;
