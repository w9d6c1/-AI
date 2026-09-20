// ===== 影刀 RPA 执行器（桩）=====
// 复用既有 server/rpa.js 的 triggerExecution；真实模式下由影刀回调回写结果。
// 自动执行默认关闭：仅在 EXECUTOR_DRIVER=rpa 且 AUTO_EXECUTE_ENABLED=true 时启用。
const { triggerExecution } = require('../../rpa');

const SUPPORTS = ['adjust_price', 'pause', 'add_budget', 'resume'];

// triggerExecution 自身会回写状态：Mock→success，真实→running（等回调）。
async function execute(item) {
  const jobIds = await triggerExecution(
    item.executionId, item.shopId, item.qianniuAccount, item.campaignId, item.action, item.targetValue || 0
  );
  const jobId = jobIds && jobIds.jobId ? jobIds.jobId : jobIds;
  return { executor: 'rpa', executionId: item.executionId, jobId };
}

module.exports = { id: 'rpa', execute, supports: SUPPORTS };
