// ===== 队列 worker =====
// 仅在队列启用时启动；每个任务在对应租户上下文内执行。
const { getConnection, enabled } = require('./index');
const { runWithTenant } = require('../repositories/tenant-context');

let workers = [];

// 队列并发（每个队列的 worker 并发数）
function workerConcurrency() {
  const n = Number(process.env.QUEUE_CONCURRENCY);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.trunc(n), 50) : 5;
}

async function startWorkers() {
  if (!enabled()) {
    console.log('[queue] 未启用（QUEUE_ENABLED!=true 或无 REDIS_URL），worker 不启动');
    return false;
  }
  const { Worker } = require('bullmq');
  const connection = getConnection();
  if (!connection) { console.warn('[queue] 连接未就绪，worker 不启动'); return false; }
  const { triggerCollection } = require('../rpa');
  const { generateSuggestions } = require('../suggestion');
  const { runAlertChecks } = require('../alert');
  const { sendNotifications } = require('../notifier');
  const { generateReport } = require('../report');

  const defs = [
    ['collect', async (job) => {
      const { tenantId, shopId, qianniuAccount, date, autoSuggest } = job.data;
      return runWithTenant(tenantId, async () => {
        const result = await triggerCollection(shopId, qianniuAccount, date);
        // B3：仅 Mock（数据已同步入库）时立即生成建议/预警；真实模式等回调完成后再生成
        if (autoSuggest && result && result.mock) {
          try { await generateSuggestions(date); } catch (e) { console.warn('[queue] 生成建议失败:', e.message); }
          try { await runAlertChecks(date); } catch (e) { console.warn('[queue] 预警检测失败:', e.message); }
        }
        return result;
      });
    }],
    ['suggest', async (job) => {
      const { tenantId, date } = job.data;
      return runWithTenant(tenantId, () => generateSuggestions(date));
    }],
    ['notify', async (job) => {
      const { tenantId, alertId } = job.data;
      return runWithTenant(tenantId, () => sendNotifications(alertId));
    }],
    ['report', async (job) => {
      const { tenantId, reportId } = job.data;
      return runWithTenant(tenantId, () => generateReport(reportId));
    }]
  ];

  workers = defs.map(([name, processor]) => {
    const w = new Worker(name, processor, { connection, concurrency: workerConcurrency() });
    w.on('failed', (job, err) => console.error(`[queue] ${name}#${job && job.id} 失败:`, err.message));
    return w;
  });
  console.log('[queue] workers 已启动:', defs.map(d => d[0]).join(', '), `(并发 ${workerConcurrency()})`);
  return true;
}

async function stopWorkers() {
  await Promise.all(workers.map(w => w.close().catch(() => {})));
  workers = [];
}

module.exports = { startWorkers, stopWorkers, workerConcurrency };
