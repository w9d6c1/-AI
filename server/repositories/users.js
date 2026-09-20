// ===== 用户仓储 =====
// 契约：所有方法异步；ctx = { tenantId } 或 { platform: true }。
// 登录/注册查找为全局（用户名全局唯一），需在 runAsPlatform 内调用。
const { currentTenant, runAsPlatform } = require('./tenant-context');
const { invalidateSession } = require('../redis');

const PUBLIC_FIELDS = 'id, username, email, role, team_id, created_at';

// 返回租户 id；平台上下文返回 null（不追加 tenant_id 过滤）
function tid(ctx = {}) {
  if (ctx.platform) return null;
  if (ctx.tenantId != null) return Number(ctx.tenantId);
  return currentTenant();
}

class UsersRepository {
  constructor(db) {
    this.db = db;
  }

  async count(ctx = {}) {
    const t = tid(ctx);
    return t == null
      ? (await this.db.get('SELECT COUNT(*) AS c FROM users')).c
      : (await this.db.get('SELECT COUNT(*) AS c FROM users WHERE tenant_id=?', [t])).c;
  }

  async findById(id, ctx = {}) {
    const t = tid(ctx);
    return t == null
      ? this.db.get(`SELECT id, username, team_id, role, session_version FROM users WHERE id=?`, [id])
      : this.db.get(`SELECT id, username, team_id, role, session_version FROM users WHERE id=? AND tenant_id=?`, [id, t]);
  }

  async findByIdPublic(id, ctx = {}) {
    const t = tid(ctx);
    return t == null
      ? this.db.get(`SELECT ${PUBLIC_FIELDS} FROM users WHERE id=?`, [id])
      : this.db.get(`SELECT ${PUBLIC_FIELDS} FROM users WHERE id=? AND tenant_id=?`, [id, t]);
  }

  // 安全字段（2FA/锁定/密码历史）
  async findSecurity(id, ctx = {}) {
    const t = tid(ctx);
    const cols = 'id, username, password_hash, totp_secret, totp_enabled, totp_recovery, failed_login_count, locked_until, password_changed_at, password_history, must_change_password';
    return t == null
      ? this.db.get(`SELECT ${cols} FROM users WHERE id=?`, [id])
      : this.db.get(`SELECT ${cols} FROM users WHERE id=? AND tenant_id=?`, [id, t]);
  }

  // 全局登录查找（用户名/邮箱全局唯一）：平台级查询
  async findByLogin(login, ctx = {}) {
    return runAsPlatform(() => this.db.get('SELECT * FROM users WHERE username=? OR email=?', [login, login]));
  }

  async existsByUsernameOrEmail(username, email, ctx = {}) {
    return runAsPlatform(() => this.db.get('SELECT id FROM users WHERE username=? OR email=?', [username, email || '']));
  }

  async list(ctx = {}) {
    const t = tid(ctx);
    return t == null
      ? this.db.all(`SELECT ${PUBLIC_FIELDS} FROM users ORDER BY id`)
      : this.db.all(`SELECT ${PUBLIC_FIELDS} FROM users WHERE tenant_id=? ORDER BY id`, [t]);
  }

  async create({ username, email, passwordHash, teamId, role, tenantId: explicitTenant }, ctx = {}) {
    const t = explicitTenant != null ? Number(explicitTenant) : (tid(ctx) ?? 1);
    const info = await this.db.run(
      'INSERT INTO users (tenant_id, username, email, password_hash, team_id, role) VALUES (?,?,?,?,?,?)',
      [t, username, email ?? null, passwordHash, teamId ?? null, role || 'member']
    );
    return info.lastInsertRowid;
  }

  // fields: { username, email, role, passwordHash }；passwordHash 变更时自动递增 session_version
  async update(id, fields = {}, ctx = {}) {
    const sets = [];
    const values = [];
    if (fields.username !== undefined) { sets.push('username=?'); values.push(fields.username); }
    if (fields.email !== undefined) { sets.push('email=?'); values.push(fields.email); }
    if (fields.role !== undefined) { sets.push('role=?'); values.push(fields.role); }
    if (fields.totp_secret !== undefined) { sets.push('totp_secret=?'); values.push(fields.totp_secret); }
    if (fields.totp_enabled !== undefined) { sets.push('totp_enabled=?'); values.push(fields.totp_enabled ? 1 : 0); }
    if (fields.totp_recovery !== undefined) { sets.push('totp_recovery=?'); values.push(fields.totp_recovery); }
    if (fields.failed_login_count !== undefined) { sets.push('failed_login_count=?'); values.push(Number(fields.failed_login_count) || 0); }
    if (fields.locked_until !== undefined) { sets.push('locked_until=?'); values.push(fields.locked_until); }
    if (fields.password_changed_at !== undefined) { sets.push('password_changed_at=?'); values.push(fields.password_changed_at); }
    if (fields.password_history !== undefined) { sets.push('password_history=?'); values.push(fields.password_history); }
    if (fields.must_change_password !== undefined) { sets.push('must_change_password=?'); values.push(fields.must_change_password ? 1 : 0); }
    if (fields.passwordHash !== undefined) {
      sets.push('password_hash=?'); values.push(fields.passwordHash);
      sets.push('session_version=session_version+1');
    }
    if (!sets.length) return { changes: 0 };
    const t = tid(ctx);
    values.push(id);
    const result = t == null
      ? await this.db.run(`UPDATE users SET ${sets.join(', ')} WHERE id=?`, values)
      : await this.db.run(`UPDATE users SET ${sets.join(', ')} WHERE id=? AND tenant_id=?`, [...values, t]);
    if (t != null && fields.passwordHash !== undefined) await invalidateSession(t, id);
    return result;
  }

  async remove(id, ctx = {}) {
    const t = tid(ctx);
    const result = t == null
      ? await this.db.run('DELETE FROM users WHERE id=?', [id])
      : await this.db.run('DELETE FROM users WHERE id=? AND tenant_id=?', [id, t]);
    if (t != null) await invalidateSession(t, id);
    return result;
  }

  async getSessionVersion(id, ctx = {}) {
    const t = tid(ctx);
    const row = t == null
      ? await this.db.get('SELECT session_version FROM users WHERE id=?', [id])
      : await this.db.get('SELECT session_version FROM users WHERE id=? AND tenant_id=?', [id, t]);
    return row ? row.session_version : null;
  }
}

module.exports = { UsersRepository };
