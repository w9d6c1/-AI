// ===== 定时采集调度服务 =====
// 基于内置 setInterval 的轻量调度器；阶段 4 迁移到队列/分布式锁。
const { repos } = require('./repositories');
const { runWithTenant, runAsPlatform, requireTenant } = require('./repositories/tenant-context');
const { upsertSql, dayPrefix } = require('./repositories/sql');
const { getClient, enabled: redisEnabled } = require('./redis');
const { triggerCollection, MOCK_MODE } = require('./rpa');
const { enqueue, enabled: queueEnabled } = require('./queue');
const { generateSuggestions } = require('./suggestion');
const { runAlertChecks } = require('./alert');
const { todayLocal, dateLocal, mapLimit, concurrency } = require('./util');
const executionService = require('./execution-service');

let timer = null;
let running = false;

function calcNextRun(schedule) {
  const now = new Date();
  const [hh, mm] = schedule.run_time.split(':').map(Number);
  const target = new Date(now);
  target.setHours(hh, mm, 0, 0);

  if (target <= now) target.setDate(target.getDate() + 1);

  if (schedule.schedule_type === 'weekly' && schedule.week_day != null) {
    const dayDiff = (schedule.week_day - target.getDay() + 7) % 7;
    if (dayDiff > 0) target.setDate(target.getDate() + dayDiff);
    else if (target <= now) target.setDate(target.getDate() + 7);
  }

  return target.toLocaleString('zh-CN');
}

async function refreshNextRun() {
  const schedules = await runAsPlatform(() => repos.adapter.all('SELECT * FROM collection_schedules WHERE enabled=1'));
  for (const s of schedules) {
    if (!s.next_run_at || _isStale(s)) {
      await runWithTenant(s.tenant_id, () => repos.adapter.run('UPDATE collection_schedules SET next_run_at=? WHERE id=? AND tenant_id=?', [calcNextRun(s), s.id, s.tenant_id]));
    }
  }
}

function _isStale(schedule) {
  if (!schedule.last_run_at) return false;
  const last = new Date(schedule.last_run_at);
  const next = schedule.next_run_at ? new Date(schedule.next_run_at) : null;
  return next && next <= new Date() && new Date() - last > 120000;
}

async function getTargetShops(schedule) {
  const t = requireTenant();
  if (schedule.target_type === 'all') {
    return repos.adapter.all("SELECT * FROM shops WHERE tenant_id=? AND status='active' ORDER BY group_id, id", [t]);
  }
  if (schedule.target_type === 'group') {
    const ids = JSON.parse(schedule.target_ids || '[]');
    if (!ids.length) return [];
    return repos.adapter.all(`SELECT * FROM shops WHERE tenant_id=? AND status='active' AND group_id IN (${ids.map(() => '?').join(',')}) ORDER BY group_id, id`, [t, ...ids]);
  }
  if (schedule.target_type === 'specific') {
    const ids = JSON.parse(schedule.target_ids || '[]');
    if (!ids.length) return [];
    return repos.adapter.all(`SELECT * FROM shops WHERE tenant_id=? AND status='active' AND id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, [t, ...ids]);
  }
  return [];
}

// 按调度所属租户建立上下文后执行
async function runSchedule(scheduleId, isRetry = false) {
  const schedule = await runAsPlatform(() => repos.adapter.get('SELECT * FROM collection_schedules WHERE id=?', [scheduleId]));
  if (!schedule) return { error: '调度不存在' };
  return runWithTenant(schedule.tenant_id, () => runScheduleInTenant(schedule, isRetry));
}

async function runScheduleInTenant(schedule, isRetry = false) {
  const t = requireTenant();
  const scheduleId = schedule.id;
  const now = new Date().toLocaleString('zh-CN');
  const today = todayLocal();
  const shops = await getTargetShops(schedule);

  const runInfo = await repos.adapter.run(
    'INSERT INTO schedule_runs (tenant_id, schedule_id, run_at, status, total_shops, retry_count) VALUES (?,?,?,?,?,?)',
    [t, scheduleId, now, 'running', shops.length, isRetry ? 1 : 0]
  );
  const runId = runInfo.lastInsertRowid;

  let successCount = 0;
  let failedCount = 0;
  const errors = [];

  await mapLimit(shops, concurrency('COLLECT_CONCURRENCY', 5), async (shop, i) => {
    const batchNo = Math.floor(i / 10) + 1;
    try {
      const ctCols = ['tenant_id', 'shop_id', 'task_date', 'batch_no', 'status'];
      await repos.adapter.run(
        upsertSql(repos.adapter.dialect, 'collection_tasks', ctCols, ['tenant_id', 'shop_id', 'task_date'], ['batch_no', 'status']),
        [t, shop.id, today, batchNo, 'queued']
      );
      const queued = await enqueue('collect', { tenantId: t, shopId: shop.id, qianniuAccount: shop.qianniu_account, date: today, autoSuggest: !!schedule.auto_suggest });
      if (!queued) await triggerCollection(shop.id, shop.qianniu_account, today);
      successCount++;
    } catch (e) {
      failedCount++;
      errors.push(`${shop.shop_name}: ${e.message}`);
    }
  });

  const status = failedCount === 0 ? 'success' : (successCount === 0 ? 'failed' : 'partial');
  const finishedAt = new Date().toLocaleString('zh-CN');

  await repos.adapter.run('UPDATE schedule_runs SET status=?, success_count=?, failed_count=?, error_msg=?, finished_at=? WHERE id=? AND tenant_id=?',
    [status, successCount, failedCount, errors.length ? errors.join('; ') : null, finishedAt, runId, t]);

  await repos.adapter.run('UPDATE collection_schedules SET last_run_at=?, last_run_status=?, next_run_at=? WHERE id=? AND tenant_id=?',
    [now, status, calcNextRun(schedule), scheduleId, t]);

  if (!queueEnabled() && MOCK_MODE && schedule.auto_suggest && successCount > 0) {
    try { await generateSuggestions(today); } catch (e) { console.error('[scheduler] 生成建议失败:', e.message); }
  }

  if (!queueEnabled() && MOCK_MODE && successCount > 0) {
    try {
      const alerts = await runAlertChecks(today);
      if (alerts.length) console.log(`[scheduler] 预警检测: 发现 ${alerts.length} 条新预警`);
    } catch (e) { console.error('[scheduler] 预警检测失败:', e.message); }
  }

  if (status !== 'success' && !isRetry && schedule.max_retries > 0) {
    const run = await repos.adapter.get('SELECT * FROM schedule_runs WHERE id=? AND tenant_id=?', [runId, t]);
    if (run.retry_count < schedule.max_retries) {
      setTimeout(() => runSchedule(scheduleId, true), schedule.retry_delay_min * 60 * 1000);
    }
  }

  return { runId, status, successCount, failedCount };
}

async function tick() {
  if (running) return;
  running = true;
  let releaseLock = null;
  let renewTimer = null;
  try {
    // 分布式锁：多副本仅一个实例执行本轮；Redis 不可用则 fail-closed（除非显式单实例）
    const redis = getClient();
    if (redis) {
      const token = `${process.pid}:${Date.now()}`;
      const ok = await redis.set('scheduler:lock', token, 'PX', 55000, 'NX');
      if (!ok) return;
      // 长循环（多租户）时定期续期，避免锁提前过期导致重复执行
      renewTimer = setInterval(async () => {
        try { if ((await redis.get('scheduler:lock')) === token) await redis.pexpire('scheduler:lock', 55000); } catch (_) { /* ignore */ }
      }, 20000);
      if (renewTimer.unref) renewTimer.unref();
      releaseLock = async () => {
        try { if ((await redis.get('scheduler:lock')) === token) await redis.del('scheduler:lock'); } catch (_) { /* ignore */ }
      };
    } else if (process.env.SCHEDULER_SINGLE_INSTANCE !== 'true') {
      console.warn('[scheduler] Redis 不可用，为避免多副本重复执行已跳过本轮（确认单实例可设 SCHEDULER_SINGLE_INSTANCE=true）');
      return;
    }

    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const today = todayLocal();
    const weekDay = now.getDay();

    const schedules = await runAsPlatform(() => repos.adapter.all('SELECT * FROM collection_schedules WHERE enabled=1'));
    for (const s of schedules) {
      if (s.run_time !== hhmm) continue;
      if (s.schedule_type === 'weekly' && s.week_day != null && s.week_day !== weekDay) continue;
      if (s.last_run_at) {
        const lastDate = dateLocal(new Date(s.last_run_at));
        if (lastDate === today) continue;
      }
      console.log(`[scheduler] 触发调度: ${s.name} (${hhmm})`);
      try { await runSchedule(s.id); } catch (e) { console.error(`[scheduler] 调度执行失败: ${s.name}`, e.message); }
    }

    // 自动执行派发（多租户）：仅当开启自动执行时
    if (executionService.autoConfig().enabled) {
      const tenants = await runAsPlatform(() => repos.adapter.all("SELECT DISTINCT tenant_id FROM executions WHERE is_auto=1 AND status='queued'"));
      for (const row of tenants) {
        try { await runWithTenant(row.tenant_id, () => executionService.processDue()); }
        catch (e) { console.error(`[scheduler] 自动执行派发失败(租户 ${row.tenant_id}):`, e.message); }
      }
    }

    // 自动出账：每月 1 日 02:00 后为上一自然月出账并开票（BILLING_AUTO_ISSUE=true）
    await maybeAutoBilling(now, today);
  } finally {
    if (renewTimer) clearInterval(renewTimer);
    if (releaseLock) await releaseLock();
    running = false;
  }
}

let lastAutoBillingDate = null;
// 自动出账：每月 1 日 02:00 后，为上一自然月出账并开票（幂等：同周期已存在则跳过）
async function maybeAutoBilling(now, today) {
  if (String(process.env.BILLING_AUTO_ISSUE || 'false') !== 'true') return;
  if (now.getDate() !== 1 || now.getHours() < 2) return;
  if (lastAutoBillingDate === today) return;
  lastAutoBillingDate = today;
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const y = prev.getFullYear();
  const m = String(prev.getMonth() + 1).padStart(2, '0');
  const lastDay = new Date(y, prev.getMonth() + 1, 0).getDate();
  const periodStart = `${y}-${m}-01`;
  const periodEnd = `${y}-${m}-${String(lastDay).padStart(2, '0')}`;
  try {
    const billing = require('./billing');
    const res = await billing.runBilling({ periodStart, periodEnd, dryRun: false, issue: true, createdBy: null });
    console.log(`[scheduler] 自动出账 ${periodStart}~${periodEnd}：生成 ${res.created.length}，跳过 ${res.skipped.length}`);
  } catch (e) {
    console.error('[scheduler] 自动出账失败:', e.message);
  }
}

async function startScheduler() {
  if (timer) return;
  if (process.env.ENABLE_SCHEDULER !== 'true') {
    console.log('[scheduler] 调度器已禁用（ENABLE_SCHEDULER=false）');
    return;
  }
  if (!redisEnabled() && process.env.SCHEDULER_SINGLE_INSTANCE !== 'true') {
    console.warn('[scheduler] 未配置 Redis：多副本下无法保证单调度，已拒绝启动调度器。单实例可设 SCHEDULER_SINGLE_INSTANCE=true。');
    return;
  }
  await refreshNextRun();
  timer = setInterval(tick, 60 * 1000);
  console.log('[scheduler] 定时采集调度器已启动 (每分钟检查)');
}

function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { startScheduler, stopScheduler, runSchedule, calcNextRun, refreshNextRun, getTargetShops };
