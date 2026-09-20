// Postgres 契约测试：仅在设置 TEST_DATABASE_URL 时执行，否则跳过。
const { test, after } = require('node:test');
const { PostgresAdapter, toPgPlaceholders } = require('../server/repositories/postgres/adapter');
const { createRepositories } = require('../server/repositories/factory');
const { bootstrapPostgres } = require('../server/db/pg-schema');
const { defineRepositoryContract } = require('./helpers/repo-contract');

const TEST_URL = process.env.TEST_DATABASE_URL;
// 安全护栏：契约测试会 TRUNCATE 表，只允许在库名含 "test" 的库上运行，避免清空应用库。
const isTestDb = !TEST_URL || /test/i.test(TEST_URL);
const skip = !TEST_URL || !isTestDb;
if (TEST_URL && !isTestDb) {
  console.warn('[postgres.contract] 拒绝在非测试库上运行（库名需含 test），已跳过:', TEST_URL);
}

test('占位符转换 ? → $n', { skip: false }, () => {
  const assert = require('node:assert/strict');
  assert.equal(toPgPlaceholders('SELECT * FROM users WHERE id=? AND name=?'), 'SELECT * FROM users WHERE id=$1 AND name=$2');
  assert.equal(toPgPlaceholders('SELECT 1'), 'SELECT 1');
});

let adapter, repos;
if (!skip) {
  adapter = new PostgresAdapter({ connectionString: TEST_URL });
  repos = createRepositories(adapter);
}

test('Postgres schema 引导', { skip }, async () => {
  await bootstrapPostgres(adapter);
  const { runMigrations } = require('../server/migrations');
  await runMigrations(adapter);
});

defineRepositoryContract({
  test,
  repos,
  adapter,
  testOptions: { skip },
  beforeEachReset: async () => {
    // CASCADE 一并清空依赖表（chats/messages/user_shop_permissions 等），
    // 避免残留外键数据导致 DELETE FROM users 失败。
    await adapter.run('TRUNCATE TABLE teams, users, shops RESTART IDENTITY CASCADE');
  }
});

after(async () => {
  if (adapter) await adapter.close();
});
