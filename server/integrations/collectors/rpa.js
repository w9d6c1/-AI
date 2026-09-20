// ===== 影刀 RPA 采集器（桩）=====
// 复用既有 server/rpa.js 的采集触发；真实模式下由影刀回调写入数据。
// 契约：{ id, platform, pull(ctx), normalize(raw) }
const { triggerCollection, MOCK_MODE } = require('../../rpa');

async function pull(ctx = {}) {
  const { shopId, qianniuAccount, reportDate, tenantId } = ctx;
  if (!shopId || !qianniuAccount || !reportDate) {
    const err = new Error('RPA 采集需要 shopId/qianniuAccount/reportDate');
    err.status = 400;
    throw err;
  }
  const jobIds = await triggerCollection(shopId, qianniuAccount, reportDate);
  return { jobIds, mock: MOCK_MODE };
}

// RPA 采集的数据由回调（/api/rpa/callback/collect）写入，normalize 不直接产出
function normalize() {
  return { dailyReports: [], campaigns: [] };
}

module.exports = { id: 'rpa', platform: 'rpa', pull, normalize, mockMode: MOCK_MODE };
