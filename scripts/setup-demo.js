require('dotenv').config();
const { repos } = require('../server/repositories');
const { insertIgnoreSql } = require('../server/repositories/sql');
const { seedTasks } = require('../server/seed');

async function setupDemo(username = 'demo') {
  const user = await repos.adapter.get('SELECT id, username, role FROM users WHERE username=?', [username]);
  if (!user) throw new Error(`未找到演示账号: ${username}`);
  if (user.role !== 'member') throw new Error('演示账号必须保持 member 角色');

  const shops = await repos.adapter.all('SELECT id FROM shops ORDER BY id');
  const sql = insertIgnoreSql(repos.adapter.dialect, 'user_shop_permissions', ['user_id', 'shop_id', 'permission_level'], ['user_id', 'shop_id']);
  await repos.tx(async () => {
    for (const shop of shops) await repos.adapter.run(sql, [user.id, shop.id, 'view']);
  });
  await seedTasks(user.id);

  return {
    username: user.username,
    shops: Number((await repos.adapter.get('SELECT COUNT(*) c FROM user_shop_permissions WHERE user_id=?', [user.id])).c),
    tasks: Number((await repos.adapter.get('SELECT COUNT(*) c FROM tasks WHERE user_id=?', [user.id])).c)
  };
}

if (require.main === module) {
  setupDemo().then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e.message); process.exit(1); });
}
module.exports = { setupDemo };
