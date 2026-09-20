// ===== 用户店铺权限仓储 =====
const { currentTenant, requireTenant } = require('./tenant-context');

function tid(ctx = {}) {
  if (ctx.tenantId != null) return Number(ctx.tenantId);
  const t = currentTenant();
  return t == null ? requireTenant() : t;
}

class UserShopPermissionsRepository {
  constructor(db) {
    this.db = db;
  }

  async listByUser(userId, ctx = {}) {
    const t = tid(ctx);
    return this.db.all(
      `SELECT usp.*, s.shop_name, s.qianniu_account
       FROM user_shop_permissions usp
       JOIN shops s ON usp.shop_id = s.id AND s.tenant_id = usp.tenant_id
       WHERE usp.user_id = ? AND usp.tenant_id = ?`,
      [userId, t]
    );
  }

  // 全量替换某用户的店铺权限（在事务中调用）
  async replaceForUser(userId, permissions = [], ctx = {}) {
    const t = tid(ctx);
    await this.db.run('DELETE FROM user_shop_permissions WHERE user_id = ? AND tenant_id = ?', [userId, t]);
    for (const p of permissions) {
      await this.db.run(
        'INSERT INTO user_shop_permissions (tenant_id, user_id, shop_id, permission_level) VALUES (?,?,?,?)',
        [t, userId, p.shop_id, p.permission_level || 'view']
      );
    }
    return permissions.length;
  }
}

module.exports = { UserShopPermissionsRepository };
