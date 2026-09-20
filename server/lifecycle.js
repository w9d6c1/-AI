// ===== 优雅停机 =====
// 顺序：停止接受新请求 → 调度器 → 队列 worker → 队列 → Redis → DB。
const logger = require('./logger');

async function shutdown({ server } = {}) {
  const steps = [];
  const run = async (name, fn) => {
    try { await fn(); steps.push({ name, ok: true }); }
    catch (e) { steps.push({ name, ok: false, error: e.message }); logger.warn('shutdown 步骤失败', { step: name, error: e.message }); }
  };

  if (server && server.listening) {
    await run('http_close', () => new Promise(resolve => {
      server.close(() => resolve());
      if (server.closeIdleConnections) server.closeIdleConnections();
      if (server.closeAllConnections) server.closeAllConnections();
    }));
  }
  await run('scheduler', () => { require('./scheduler').stopScheduler(); });
  await run('workers', async () => { await require('./queue/workers').stopWorkers(); });
  await run('queues', async () => { await require('./queue').closeQueues(); });
  await run('redis', async () => { await require('./redis').closeRedis(); });
  await run('db', async () => {
    const { defaultAdapter } = require('./repositories');
    if (defaultAdapter && typeof defaultAdapter.close === 'function') await defaultAdapter.close();
  });

  logger.info('优雅停机完成', { steps });
  return steps;
}

function installSignalHandlers(server) {
  let shuttingDown = false;
  const make = (signal) => async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('收到停机信号', { signal });
    const timeout = Number(process.env.SHUTDOWN_TIMEOUT_MS || 10000);
    const t = setTimeout(() => { logger.error('停机超时，强制退出'); process.exit(1); }, timeout);
    if (t.unref) t.unref();
    await shutdown({ server });
    process.exit(0);
  };
  process.on('SIGTERM', make('SIGTERM'));
  process.on('SIGINT', make('SIGINT'));
  return () => shuttingDown;
}

module.exports = { shutdown, installSignalHandlers };
