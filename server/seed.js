// ===== 种子数据（异步，走仓储适配器）=====
const bcrypt = require('bcryptjs');
const { repos } = require('./repositories');
const { requireTenant } = require('./repositories/tenant-context');

async function seedCourses() {
  const count = Number((await repos.adapter.get('SELECT COUNT(*) AS c FROM courses')).c);
  if (count > 0) return;
  const courses = [
    ['淘宝天猫运营从入门到精通','运营','🚀','linear-gradient(135deg,#0d9488,#14b8a6)','12课时 · 3h20m','入门','系统讲解淘宝天猫平台运营全流程，从店铺搭建、商品上架、流量获取到推广优化，涵盖运营人员必备核心技能。'],
    ['直通车精准投放实战','运营','💰','linear-gradient(135deg,#f59e0b,#fbbf24)','8课时 · 2h10m','进阶','深入解析直通车推广机制，从关键词选择、出价策略、人群定向到质量分优化，传授经过验证的投放技巧。'],
    ['高转化主图与详情页设计','视觉','🎨','linear-gradient(135deg,#8b5cf6,#a78bfa)','10课时 · 2h45m','进阶','从用户视觉心理出发，系统讲解主图点击率提升技巧和详情页转化逻辑。'],
    ['AI 时代的选品策略','选品','🔍','linear-gradient(135deg,#3b82f6,#60a5fa)','6课时 · 1h50m','入门','结合 AI 工具与数据分析方法，教你如何科学选品，涵盖市场趋势判断、竞争度分析、利润测算等。'],
    ['电商团队管理与绩效设计','管理','👥','linear-gradient(135deg,#ef4444,#f87171)','9课时 · 2h30m','高级','针对电商企业团队管理痛点，讲解组织架构设计、绩效考核体系搭建、激励机制设计等内容。'],
    ['电商财税合规与风险防控','财税','⚖️','linear-gradient(135deg,#0891b2,#06b6d4)','7课时 · 2h00m','进阶','系统梳理电商企业常见财税风险点，讲解发票管理、成本核算、税务筹划、合规经营等核心内容。'],
    ['短视频与直播带货运营','运营','📹','linear-gradient(135deg,#ec4899,#f472b6)','11课时 · 3h00m','进阶','全面讲解抖音/快手短视频与直播带货的运营方法，包括账号定位、内容策划、直播话术、投流策略等。'],
    ['商品视觉拍摄技巧','视觉','📷','linear-gradient(135deg,#65a30d,#84cc16)','5课时 · 1h30m','入门','零基础学习电商商品拍摄，涵盖布光技巧、背景选择、构图方法、手机拍摄技巧等内容。'],
    ['竞品分析方法论','选品','📊','linear-gradient(135deg,#0d9488,#2dd4bf)','6课时 · 1h40m','进阶','系统学习竞品分析的完整方法论，从竞品选择、数据采集、维度拆解到策略输出。'],
    ['客服话术与转化率提升','管理','💬','linear-gradient(135deg,#f59e0b,#fcd34d)','4课时 · 1h10m','入门','总结电商客服高频场景的标准话术，包括咨询应答、议价处理、售后安抚、催单技巧等。'],
    ['万相台与超级推荐投放','运营','🎯','linear-gradient(135deg,#6366f1,#818cf8)','7课时 · 1h55m','高级','深入讲解万相台和超级推荐的投放机制与优化技巧，包含智能计划搭建、人群包管理、出价策略等。'],
    ['电商成本核算与利润管理','财税','📈','linear-gradient(135deg,#14b8a6,#2dd4bf)','5课时 · 1h25m','入门','教你建立电商企业的成本核算体系，涵盖产品成本、物流费用、推广花费、平台扣点等全成本项核算方法。']
  ];
  for (const c of courses) {
    await repos.adapter.run('INSERT INTO courses (title,cat,icon,color,duration,level,"desc") VALUES (?,?,?,?,?,?,?)', c);
  }
}

async function seedTasks(userId) {
  const t = requireTenant();
  const count = Number((await repos.adapter.get('SELECT COUNT(*) AS c FROM tasks WHERE user_id=? AND tenant_id=?', [userId, t])).c);
  if (count > 0) return;
  const tasks = [
    ['每日经营日报','📊','#f0fdfa','每日 9:00 自动生成昨日经营数据日报','每日 09:00',1],
    ['选品蓝海监控','🔍','#eff6ff','每周扫描市场，挖掘新蓝海机会词','每周一 10:00',1],
    ['低效推广计划关停','🛑','#fef2f2','实时监控推广计划，ROI 低于阈值自动暂停','实时',1],
    ['主图 AB 测试','🖼️','#fffbeb','自动生成多版本主图并轮播测试，保留最优','每周三 09:00',0],
    ['竞品价格监控','👁️','#f3e8ff','监控核心竞品价格变动，异常时自动预警','每 6 小时',1],
    ['差评自动回复','💬','#f0fdfa','AI 自动生成差评回复话术，人工确认后发送','实时',0]
  ];
  for (const task of tasks) {
    await repos.adapter.run('INSERT INTO tasks (user_id,name,icon,color,"desc",freq,enabled,tenant_id) VALUES (?,?,?,?,?,?,?,?)', [userId, ...task, t]);
  }
}

async function seedShops() {
  const t = requireTenant();
  const count = Number((await repos.adapter.get('SELECT COUNT(*) AS c FROM shops WHERE tenant_id=?', [t])).c);
  if (count > 0) return;
  for (let i = 1; i <= 5; i++) {
    await repos.adapter.run('INSERT INTO shop_groups (name, batch_no, tenant_id) VALUES (?,?,?)', [`批次${i}`, i, t]);
  }
  const shopNames = [
    '潮流女装旗舰店', '男装精选店', '母婴优品馆', '美妆达人店', '数码配件专营',
    '家居生活馆', '食品零食铺', '运动户外店', '汽车用品店', '珠宝饰品馆',
    '童装童鞋店', '宠物用品店', '图书文具店', '家电专营店', '鲜花礼品店',
    '陶瓷工艺品店', '茶叶专营店', '酒水直供店', '床上用品店', '厨房用品馆'
  ];
  const groups = await repos.adapter.all('SELECT id, batch_no FROM shop_groups WHERE tenant_id=? ORDER BY batch_no', [t]);
  for (let i = 0; i < shopNames.length; i++) {
    const batchNo = Math.min(5, Math.floor(i / 4) + 1);
    const group = groups.find(g => g.batch_no === batchNo);
    await repos.adapter.run(
      'INSERT INTO shops (shop_name, wangwang_id, qianniu_account, rpa_robot_id, group_id, status, daily_adjust_limit, tenant_id) VALUES (?,?,?,?,?,?,?,?)',
      [shopNames[i], `ww_${String(i + 1).padStart(3, '0')}`, `shop${String(i + 1).padStart(3, '0')}`, `robot_${String(i + 1).padStart(3, '0')}`, group ? group.id : null, 'active', 5, t]
    );
  }
}

async function seedDefaultUsers() {
  const t = requireTenant();
  const count = Number((await repos.adapter.get('SELECT COUNT(*) AS c FROM users WHERE tenant_id=?', [t])).c);
  if (count > 0) return;
  if (process.env.SEED_DEFAULT_USERS !== 'true') {
    console.log('[seed] 未创建默认用户。空库首次启动请临时设置 SEED_DEFAULT_USERS=true 与 ADMIN_PASSWORD。');
    return;
  }
  if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12) throw new Error('首次创建管理员必须设置至少 12 位 ADMIN_PASSWORD');
  const username = process.env.ADMIN_USERNAME || 'admin';
  const teamId = await repos.teams.create('默认团队', null);
  const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10);
  const uid = await repos.users.create({ username, email: process.env.ADMIN_EMAIL || 'admin@ecom-ai.local', passwordHash: hash, teamId, role: 'admin' });
  await repos.teams.setOwner(teamId, uid);
  console.log(`[seed] 已创建管理员（用户名: ${username}）。请立即关闭 SEED_DEFAULT_USERS。`);
}

// 平台超管（superadmin）：仅当 SEED_SUPERADMIN=true 时创建，用于租户运营/代登录
async function seedSuperadmin() {
  if (process.env.SEED_SUPERADMIN !== 'true') return;
  const username = process.env.SUPERADMIN_USERNAME || 'superadmin';
  const existing = await repos.users.findByLogin(username);
  if (existing) return;
  if (!process.env.SUPERADMIN_PASSWORD || process.env.SUPERADMIN_PASSWORD.length < 12) {
    throw new Error('SEED_SUPERADMIN=true 时必须设置至少 12 位 SUPERADMIN_PASSWORD');
  }
  const hash = bcrypt.hashSync(process.env.SUPERADMIN_PASSWORD, 10);
  await repos.users.create({ username, email: process.env.SUPERADMIN_EMAIL || null, passwordHash: hash, teamId: null, role: 'superadmin', tenantId: 1 });
  console.log(`[seed] 已创建平台超管（用户名: ${username}）。请立即关闭 SEED_SUPERADMIN。`);
}

module.exports = { seedCourses, seedTasks, seedShops, seedDefaultUsers, seedSuperadmin };
