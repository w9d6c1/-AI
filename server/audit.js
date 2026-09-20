// ===== 审计写入（跨租户/平台上下文安全）=====
const { repos } = require('./repositories');
const { runWithTenant, currentTenant } = require('./repositories/tenant-context');

// tenantId 必须显式提供（默认租户 1）；若当前上下文不同则以 runWithTenant 包裹。
async function audit({ tenantId = 1, userId = null, shopId = null, action, targetType = null, targetId = null, detail = null, ip = null, userAgent = null }) {
  const tid = Number(tenantId) || 1;
  const insert = () => repos.adapter.run(
    'INSERT INTO audit_logs (tenant_id,user_id,shop_id,action,target_type,target_id,detail_json,ip_address,user_agent) VALUES (?,?,?,?,?,?,?,?,?)',
    [tid, userId ?? null, shopId ?? null, action, targetType, targetId != null ? String(targetId) : null, detail ? JSON.stringify(detail) : null, ip ?? null, userAgent ?? null]
  );
  if (currentTenant() === tid) return insert();
  return runWithTenant(tid, insert);
}

module.exports = { audit };
