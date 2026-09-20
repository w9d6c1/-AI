// ===== 人工执行器（默认）=====
// 人工执行：不下发 RPA，仅将 execution 置为待人工处理，进入执行清单；
// 运营在线下（千牛后台）完成后回填 actual_value，由对账使用。
// 契约：{ id, execute(item) -> result, supports: [...] }
const { repos } = require('../../repositories');
const { requireTenant } = require('../../repositories/tenant-context');
const { nowLocal } = require('../../util');

const SUPPORTS = ['adjust_price', 'pause', 'add_budget', 'resume'];

async function execute(item) {
  const t = requireTenant();
  await repos.adapter.run(
    "UPDATE executions SET status=?, started_at=?, error_msg=NULL WHERE id=? AND tenant_id=?",
    ['pending_manual', nowLocal(), item.executionId, t]
  );
  return { executor: 'manual', status: 'pending_manual', executionId: item.executionId };
}

module.exports = { id: 'manual', execute, supports: SUPPORTS };
