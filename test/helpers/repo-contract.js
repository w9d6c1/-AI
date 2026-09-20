// ===== 仓储契约测试（SQLite / Postgres 共用）=====
// 调用方传入具体仓储实现与可选的重置钩子，保证两库行为一致。
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { runWithTenant } = require('../../server/repositories/tenant-context');

function defineRepositoryContract({ test, repos, adapter, beforeEachReset, testOptions = {} }) {
  const reset = async () => { if (beforeEachReset) await beforeEachReset(); };
  const it = (name, fn) => test(name, testOptions, () => runWithTenant(1, fn));

  it('用户仓储 CRUD 与登录查询', async () => {
    await reset();
    const teamId = await repos.teams.create('测试团队');
    const hash = bcrypt.hashSync('TestPassword123!', 4);
    const uid = await repos.users.create({ username: 'repo_user', email: 'repo@example.com', passwordHash: hash, teamId, role: 'member' });
    assert.ok(uid > 0);

    const byName = await repos.users.findByLogin('repo_user');
    assert.equal(byName.id, uid);
    const byEmail = await repos.users.findByLogin('repo@example.com');
    assert.equal(byEmail.id, uid);

    const found = await repos.users.findById(uid);
    assert.equal(found.username, 'repo_user');
    assert.equal(Number(found.session_version), 0);

    assert.ok(await repos.users.existsByUsernameOrEmail('repo_user'));
    assert.ok(await repos.users.existsByUsernameOrEmail('x', 'repo@example.com'));

    await repos.users.update(uid, { role: 'admin', email: 'changed@example.com' });
    const updated = await repos.users.findByIdPublic(uid);
    assert.equal(updated.role, 'admin');
    assert.equal(updated.email, 'changed@example.com');
    assert.equal(updated.password_hash, undefined);

    await repos.users.update(uid, { passwordHash: bcrypt.hashSync('AnotherPass123!', 4) });
    assert.equal(Number(await repos.users.getSessionVersion(uid)), 1);

    await repos.users.remove(uid);
    assert.equal(await repos.users.findById(uid), undefined);
  });

  it('事务回滚：中间失败不留部分数据', async () => {
    await reset();
    const before = Number(await repos.users.count());
    await assert.rejects(
      repos.tx(async () => {
        await repos.users.create({ username: 'tx_user', passwordHash: 'x' });
        throw new Error('boom');
      }),
      /boom/
    );
    assert.equal(Number(await repos.users.count()), before);
  });

  it('权限仓储：全量替换并关联店铺', async () => {
    await reset();
    const uid = await repos.users.create({ username: 'perm_user', passwordHash: 'x' });
    await adapter.run('INSERT INTO shops (id, tenant_id, shop_name, qianniu_account) VALUES (?,?,?,?)', [101, 1, '权限店A', 'perm_a']);
    await adapter.run('INSERT INTO shops (id, tenant_id, shop_name, qianniu_account) VALUES (?,?,?,?)', [102, 1, '权限店B', 'perm_b']);

    const count = await repos.tx(async () => repos.permissions.replaceForUser(uid, [
      { shop_id: 101, permission_level: 'view' },
      { shop_id: 102, permission_level: 'operate' }
    ]));
    assert.equal(Number(count), 2);
    const perms = await repos.permissions.listByUser(uid);
    assert.equal(perms.length, 2);
    assert.ok(perms.every(p => p.shop_name));

    const count2 = await repos.tx(async () => repos.permissions.replaceForUser(uid, [{ shop_id: 101 }]));
    assert.equal(Number(count2), 1);
    const perms2 = await repos.permissions.listByUser(uid);
    assert.equal(perms2.length, 1);
    assert.equal(perms2[0].permission_level, 'view');
  });

  it('租户上下文参数被接受（阶段 3 生效）', async () => {
    await reset();
    const uid = await repos.users.create({ username: 'tenant_user', passwordHash: 'x' });
    const found = await repos.users.findById(uid, { tenantId: 1 });
    assert.equal(found.username, 'tenant_user');
    const list = await repos.users.list({ tenantId: 1 });
    assert.ok(Array.isArray(list));
  });
}

module.exports = { defineRepositoryContract };
