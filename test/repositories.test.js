const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecom-repo-'));
Object.assign(process.env, {
  DATA_DIR: path.join(root, 'data'), DB_PATH: path.join(root, 'data/ecom-ai.db'), UPLOAD_DIR: path.join(root, 'uploads'),
  JWT_SECRET: crypto.randomBytes(32).toString('hex'), DB_DRIVER: 'sqlite'
});
const { db } = require('../server/db');
const { defaultAdapter, repos } = require('../server/repositories');
const { runMigrations } = require('../server/migrations');
const { defineRepositoryContract } = require('./helpers/repo-contract');

test('迁移幂等：首次应用基线，重复运行为空', async () => {
  const first = await runMigrations(defaultAdapter);
  assert.deepEqual(first, ['0001_baseline', '0002_collection_tasks_constraints', '0003_tenants', '0004_ai_usage', '0005_stage2_integrations', '0006_stage3_data_model', '0007_stage4_ai', '0008_stage5_execution_closure', '0009_stage7_security', '0010_stage9_billing', '0011_stage9_quota_tokens']);
  const second = await runMigrations(defaultAdapter);
  assert.deepEqual(second, []);
  const rows = await defaultAdapter.all('SELECT id FROM schema_migrations ORDER BY id');
  assert.equal(rows.length, 11);
});

async function beforeEachReset() {
  await defaultAdapter.run('DELETE FROM user_shop_permissions WHERE tenant_id=?', [1]);
  await defaultAdapter.run('DELETE FROM users WHERE tenant_id=?', [1]);
  await defaultAdapter.run('DELETE FROM teams WHERE tenant_id=?', [1]);
  await defaultAdapter.run('DELETE FROM shops WHERE tenant_id=?', [1]);
}

defineRepositoryContract({ test, repos, adapter: defaultAdapter, beforeEachReset });

after(() => {
  db.close();
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('ecom-repo-')) throw new Error('拒绝清理不符合测试范围的路径');
  fs.rmSync(resolved, { recursive: true, force: true });
});
