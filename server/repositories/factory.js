// ===== 仓储工厂：按适配器组装领域仓储（不依赖具体驱动）=====
const { UsersRepository } = require('./users');
const { TeamsRepository } = require('./teams');
const { UserShopPermissionsRepository } = require('./permissions');

function createRepositories(adapter) {
  return {
    adapter,
    users: new UsersRepository(adapter),
    teams: new TeamsRepository(adapter),
    permissions: new UserShopPermissionsRepository(adapter),
    tx: (fn) => adapter.tx(fn)
  };
}

module.exports = { createRepositories };
