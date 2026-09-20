// ===== 团队仓储 =====
const { currentTenant, requireTenant } = require('./tenant-context');

function tid(ctx = {}) {
  if (ctx.tenantId != null) return Number(ctx.tenantId);
  const t = currentTenant();
  return t == null ? requireTenant() : t;
}

class TeamsRepository {
  constructor(db) {
    this.db = db;
  }

  async create(name, ownerId = null, ctx = {}) {
    const info = await this.db.run(
      'INSERT INTO teams (tenant_id, name, owner_id) VALUES (?,?,?)',
      [tid(ctx), name, ownerId]
    );
    return info.lastInsertRowid;
  }

  async setOwner(teamId, ownerId, ctx = {}) {
    return this.db.run('UPDATE teams SET owner_id=? WHERE id=? AND tenant_id=?', [ownerId, teamId, tid(ctx)]);
  }

  async findById(id, ctx = {}) {
    return this.db.get('SELECT id, name FROM teams WHERE id=? AND tenant_id=?', [id, tid(ctx)]);
  }
}

module.exports = { TeamsRepository };
