// ===== SQLite 适配器：把 node:sqlite 的同步 API 包装成异步仓储契约 =====
// 所有仓储通过该适配器访问数据库，未来可替换为 Postgres 适配器（同契约）。
const { assertTenantScoped } = require('../tenant-guard');

class SqliteAdapter {
  constructor(db) {
    if (!db) throw new Error('SqliteAdapter 需要 DatabaseSync 实例');
    this.db = db;
    this.dialect = 'sqlite';
  }

  async all(sql, params = []) {
    assertTenantScoped(sql);
    return this.db.prepare(sql).all(...params);
  }

  async get(sql, params = []) {
    assertTenantScoped(sql);
    return this.db.prepare(sql).get(...params);
  }

  async run(sql, params = []) {
    assertTenantScoped(sql);
    return this.db.prepare(sql).run(...params);
  }

  async exec(sql) {
    return this.db.exec(sql);
  }

  // 事务：fn 接收当前适配器，内部使用同一连接
  async tx(fn) {
    this.db.exec('BEGIN');
    try {
      const result = await fn(this);
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
      throw e;
    }
  }
}

module.exports = { SqliteAdapter };
