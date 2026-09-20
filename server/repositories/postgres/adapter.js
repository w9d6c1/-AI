// ===== Postgres 适配器：与 SQLite 适配器同契约（all/get/run/exec/tx） =====
// 负责：连接池、? → $n 占位符转换、INSERT 返回自增 id、事务。
// 事务通过 AsyncLocalStorage 绑定客户端，保证事务回调内所有仓储调用走同一连接。
const { Pool } = require('pg');
const { AsyncLocalStorage } = require('node:async_hooks');
const { assertTenantScoped } = require('../tenant-guard');

const txStorage = new AsyncLocalStorage();

function toPgPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + (++i));
}

class PostgresAdapter {
  constructor(opts = {}) {
    this.dialect = 'postgres';
    this.pool = opts.pool || new Pool({
      connectionString: opts.connectionString || process.env.DATABASE_URL,
      max: Number(process.env.PG_POOL_MAX || 10)
    });
  }

  async _query(text, params) {
    const client = txStorage.getStore();
    const runner = client || this.pool;
    return runner.query(text, params);
  }

  async all(sql, params = []) {
    assertTenantScoped(sql);
    const r = await this._query(toPgPlaceholders(sql), params);
    return r.rows;
  }

  async get(sql, params = []) {
    const rows = await this.all(sql, params);
    return rows[0];
  }

  async run(sql, params = []) {
    assertTenantScoped(sql);
    let text = toPgPlaceholders(sql);
    // 无 RETURNING 的 INSERT 自动补 RETURNING *，兼容 SQLite 的 lastInsertRowid。
    // 用 * 而非 id：部分表（如 file_assets，主键为 url）没有 id 列，补 id 会报错。
    if (/^\s*insert\b/i.test(text) && !/\breturning\b/i.test(text)) {
      text += ' RETURNING *';
    }
    const r = await this._query(text, params);
    const row = r.rows && r.rows[0];
    return {
      changes: r.rowCount,
      lastInsertRowid: row ? row.id : undefined
    };
  }

  async exec(sql) {
    return this._query(sql, []);
  }

  async tx(fn) {
    if (txStorage.getStore()) return fn(this); // 嵌套事务复用当前客户端
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await txStorage.run(client, () => fn(this));
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
      throw e;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = { PostgresAdapter, toPgPlaceholders };
