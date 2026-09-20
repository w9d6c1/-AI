// 单公司内部试用：管理员管理全部店铺，员工按授权读取。
// 数据访问走异步仓储；isAdmin/httpError 保持同步。
const { repos } = require('./repositories');
const { requireTenant } = require('./repositories/tenant-context');

function isAdmin(user) { return ['boss', 'admin'].includes(user.role); }
function httpError(status, message) { return Object.assign(new Error(message), { status }); }

async function getAccessibleShopIds(user) {
  const t = requireTenant();
  if (isAdmin(user)) {
    const rows = await repos.adapter.all('SELECT id FROM shops WHERE tenant_id=? ORDER BY id', [t]);
    return rows.map(r => r.id);
  }
  const rows = await repos.adapter.all('SELECT shop_id FROM user_shop_permissions WHERE user_id=? AND tenant_id=?', [user.id, t]);
  return rows.map(r => r.shop_id);
}

async function resolveShopIds(user, requested) {
  const allowed = await getAccessibleShopIds(user);
  if (requested == null) return allowed;
  let ids = requested;
  if (typeof ids === 'string') {
    try { ids = JSON.parse(ids); } catch { throw httpError(400, 'shop_ids 必须为店铺 ID 数组'); }
  }
  if (!Array.isArray(ids) || ids.length > 1000 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw httpError(400, 'shop_ids 必须为正整数数组（最多 1000 项）');
  }
  if (ids.some(id => !allowed.includes(id))) throw httpError(403, '无权访问所选店铺');
  return [...new Set(ids)];
}

async function canAccessReport(user, record) {
  if (isAdmin(user)) return true;
  if (record.created_by !== user.id || !record.shop_ids) return false;
  try {
    const ids = JSON.parse(record.shop_ids);
    if (!Array.isArray(ids)) return false;
    const allowed = await getAccessibleShopIds(user);
    return ids.every(id => allowed.includes(id));
  } catch { return false; }
}

module.exports = { isAdmin, httpError, getAccessibleShopIds, resolveShopIds, canAccessReport };
