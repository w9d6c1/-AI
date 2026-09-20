const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecom-regression-'));
const USE_PG = /^(postgres|pg)$/i.test(process.env.DB_DRIVER || '');

Object.assign(process.env, {
  DATA_DIR: path.join(root, 'data'), DB_PATH: path.join(root, 'data/ecom-ai.db'), UPLOAD_DIR: path.join(root, 'uploads'),
  JWT_SECRET: crypto.randomBytes(32).toString('hex'), RPA_CALLBACK_TOKEN: crypto.randomBytes(32).toString('hex'),
  AI_API_KEY: '', AI_IMAGE_API_KEY: '', ALLOW_REGISTRATION: 'false', ENABLE_SCHEDULER: 'false',
  SEED_DEFAULT_USERS: 'false', SEED_DEMO_DATA: 'false', RPA_MOCK_MODE: 'true', TRUST_PROXY: '', CORS_ORIGIN: ''
});

// PG 模式：强制使用独立测试库（<name>_test），避免误清开发库数据。
if (USE_PG) {
  const raw = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!raw) throw new Error('DB_DRIVER=postgres 回归需要 TEST_DATABASE_URL 或 DATABASE_URL');
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '') || 'ecom';
  if (!/_test$/.test(name)) url.pathname = '/' + name + '_test';
  process.env.DATABASE_URL = url.toString();
  process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
}

const app = require('../server/index');
const { defaultAdapter } = require('../server/repositories');
const { runWithTenant } = require('../server/repositories/tenant-context');
const { signToken } = require('../server/middleware');
const { snapshot } = require('../scripts/backup');
const { restore } = require('../scripts/restore');
const { DatabaseSync } = require('node:sqlite');
// 始终加载 SQLite 句柄：SQLite 模式作为被测库；PG 模式下 server/db 仍会打开一个
// 临时 SQLite 文件，需在收尾时关闭，否则 Windows 上无法删除临时目录。
const db = require('../server/db').db;

const users = {};
let sid;
let server, base;

const run = (sql, params) => defaultAdapter.run(sql, params);
const get = (sql, params) => defaultAdapter.get(sql, params);
const countRows = async (table) => Number((await get('SELECT COUNT(*) c FROM ' + table + ' WHERE tenant_id=?', [1])).c);

async function ensureTestDatabase() {
  const { Pool } = require('pg');
  const admin = new URL(process.env.DATABASE_URL);
  const name = admin.pathname.replace(/^\//, '');
  admin.pathname = '/postgres';
  const pool = new Pool({ connectionString: admin.toString() });
  try {
    const exists = await pool.query('SELECT 1 FROM pg_database WHERE datname=$1', [name]);
    if (!exists.rowCount) await pool.query(`CREATE DATABASE "${name}"`);
  } finally {
    await pool.end();
  }
}

async function seedFixtures() {
  for (const [name, role] of [['admin', 'admin'], ['alice', 'member'], ['bob', 'member'], ['empty', 'member']]) {
    const r = await run('INSERT INTO users (tenant_id,username,password_hash,role) VALUES (?,?,?,?)', [1, name, bcrypt.hashSync('TestPassword123!', 4), role]);
    users[name] = { id: r.lastInsertRowid, role };
  }
  for (const [id, name] of [[1, '=HYPERLINK("example")'], [2, '另一店铺']]) {
    await run('INSERT INTO shops (id,tenant_id,shop_name,qianniu_account) VALUES (?,?,?,?)', [id, 1, name, 'shop-' + id]);
  }
  for (const name of ['alice', 'bob']) await run('INSERT INTO user_shop_permissions (tenant_id,user_id,shop_id) VALUES (?,?,?)', [1, users[name].id, name === 'alice' ? 1 : 2]);
  for (const [shop, date, pay, visitors, buyers, cost, adpay] of [[1, '2026-09-19', 1000, 100, 10, 100, 400], [2, '2026-09-19', 9000, 1000, 20, 900, 1800], [1, '2026-09-18', 500, 50, 5, 50, 150]]) {
    await run('INSERT INTO daily_reports (tenant_id,shop_id,report_date,visitors,payed_buyer_count,pay_amount) VALUES (?,?,?,?,?,?)', [1, shop, date, visitors, buyers, pay]);
    await run('INSERT INTO ad_campaigns (tenant_id,shop_id,campaign_id,campaign_name,report_date,cost,pay_amount,impressions,clicks,roi) VALUES (?,?,?,?,?,?,?,?,?,?)', [1, shop, 'c' + shop, 'Campaign', date, cost, adpay, 1000, 100, adpay / cost]);
    await run('INSERT INTO alerts (tenant_id,shop_id,alert_type,severity,title,message,triggered_at) VALUES (?,?,?,?,?,?,?)', [1, shop, 'test', 'warning', 'Alert', 'message', date + ' 12:00:00']);
    await run('INSERT INTO executions (tenant_id,shop_id,action_type,target_campaign_id,status,created_at) VALUES (?,?,?,?,?,?)', [1, shop, 'pause', 'c' + shop, 'success', date + ' 12:00:00']);
    await run('INSERT INTO collection_tasks (tenant_id,shop_id,task_date,status) VALUES (?,?,?,?)', [1, shop, date, 'success']);
  }
  sid = (await run('INSERT INTO suggestions (tenant_id,shop_id,suggestion_date) VALUES (?,?,?)', [1, 2, '2026-09-19'])).lastInsertRowid;
}

before(async () => {
  await runWithTenant(1, async () => {
    if (USE_PG) {
      await ensureTestDatabase();
      const { bootstrapPostgres } = require('../server/db/pg-schema');
      await run('DROP SCHEMA public CASCADE');
      await run('CREATE SCHEMA public');
      await bootstrapPostgres(defaultAdapter);
      const { runMigrations } = require('../server/migrations');
      await runMigrations(defaultAdapter);
    }
    await seedFixtures();
    for (const u of Object.values(users)) u.token = await signToken({ id: u.id, tenant_id: 1 });
  });
});

async function req(url, user = 'alice', method = 'GET', body) {
  const headers = user ? { Authorization: 'Bearer ' + users[user].token } : {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(base + '/api' + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function json(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (USE_PG) await defaultAdapter.close();
  try { db.close(); } catch (_) { /* 已关闭或未使用 */ }
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('ecom-regression-')) throw new Error('拒绝清理不符合测试范围的路径');
  fs.rmSync(resolved, { recursive: true, force: true });
});
test('内部试用集成回归', async t => runWithTenant(1, async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  await t.test('默认关闭注册、匿名接口被拒绝、不接受 URL 登录 token', async () => {
    await json(await req('/auth/register', null, 'POST', { username: 'newuser', password: 'TestPassword123!' }), 403);
    await json(await req('/reports', null), 401);
    await json(await req('/dashboard/stats', null), 401);
    await json(await req('/reports?token=' + users.alice.token, null), 401);
    const response = await fetch(base + '/api/health', { headers: { Origin: 'https://untrusted.example' } });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });
  await t.test('经营概览按授权和日期计算，ROI 使用广告成交，空权限返回零', async () => {
    const a = await json(await req('/analytics/overview?date_start=2026-09-19&date_end=2026-09-19'));
    assert.equal(a.summary.total_pay, 1000); assert.equal(a.summary.total_cost, 100); assert.equal(a.summary.avg_roi, 4); assert.equal(a.summary.avg_cvr, 10);
    const all = await json(await req('/analytics/overview?date_start=2026-09-19&date_end=2026-09-19', 'admin'));
    assert.equal(all.summary.total_pay, 10000); assert.equal(all.summary.avg_roi, 2.2); assert.ok(Math.abs(all.summary.avg_cvr - 30 / 1100 * 100) < 0.0001);
    const empty = await json(await req('/analytics/overview', 'empty')); assert.equal(empty.summary.total_pay, 0); assert.deepEqual(empty.trend, []);
    await json(await req('/analytics/overview?shop_ids=[2]'), 403);
    await json(await req('/analytics/overview?shop_ids=oops'), 400);
    await json(await req('/analytics/overview?date_start=2026-02-30'), 400);
  });
  let ownReport;
  await t.test('五种报表 CSV/JSON 均正确；店铺、日期筛选及下载完整', async () => {
    for (const type of ['daily_summary', 'weekly_trend', 'roi_analysis', 'alert_summary', 'execution_report']) {
      for (const format of ['json', 'csv']) {
        const created = await json(await req('/reports', 'alice', 'POST', { name: 'test', report_type: type, file_format: format, shop_ids: [1], date_start: '2026-09-19', date_end: '2026-09-19' }), 201);
        ownReport = created.id;
        assert.equal(created.row_count, 1); assert.equal(created.status, 'completed');
        const download = await req('/reports/' + created.id + '/download'); assert.equal(download.status, 200);
        assert.ok(download.headers.get('content-disposition').includes('.' + format));
        if (format === 'json') {
          const report = await download.json(); assert.equal(report.total_rows, 1);
          assert.ok(!JSON.stringify(report).includes('另一店铺'));
          if (type === 'daily_summary') assert.equal(report.rows[0].pay_amount, 1000);
          if (type === 'weekly_trend') assert.equal(report.rows[0].roi, 4);
        } else {
          const csv = await download.text(); assert.ok(csv.length > 10);
          if (type === 'daily_summary') assert.ok(csv.includes("'=HYPERLINK"));
        }
      }
    }
  });
  await t.test('不能读取、删除他人报表；权限撤销即时生效；旧全店报表不能泄露', async () => {
    assert.deepEqual((await json(await req('/reports', 'bob'))).reports, []);
    await json(await req('/reports/' + ownReport + '/download', 'bob'), 404);
    await json(await req('/reports/' + ownReport, 'bob', 'DELETE'), 404);
    await run('DELETE FROM user_shop_permissions WHERE user_id=? AND tenant_id=?', [users.alice.id, 1]);
    await json(await req('/reports/' + ownReport + '/download'), 404);
    await run('INSERT INTO user_shop_permissions (tenant_id,user_id,shop_id) VALUES (?,?,1)', [1, users.alice.id]);
    const legacy = (await run('INSERT INTO report_records (tenant_id,name,report_type,created_by) VALUES (?,?,?,?)', [1, 'legacy', 'daily_summary', users.alice.id])).lastInsertRowid;
    await json(await req('/reports/' + legacy + '/download'), 404);
    const listed = await json(await req('/reports')); assert.ok(listed.reports.every(r => !('file_path' in r)));
  });
  await t.test('空数据/空店铺正常生成零行报表；错误输入不创建记录', async () => {
    for (const [user, ids] of [['alice', []], ['empty', undefined]]) {
      const c = await json(await req('/reports', user, 'POST', { name: 'empty', report_type: 'daily_summary', shop_ids: ids, date_start: '2025-01-01', date_end: '2025-01-01' }), 201);
      assert.equal(c.row_count, 0);
    }
    for (const body of [{ shop_ids: [2] }, { date_start: '2026-02-30' }, { date_start: '2026-09-20', date_end: '2026-09-19' }, { file_format: 'exe' }, { report_type: 'toString' }]) {
      const before = await countRows('report_records');
      await json(await req('/reports', 'alice', 'POST', { name: 'invalid', report_type: 'daily_summary', ...body }), body.shop_ids ? 403 : 400);
      assert.equal(await countRows('report_records'), before);
    }
  });
  await t.test('模板归属和全局操作边界；建议与采集记录按店铺隔离', async () => {
    const template = (await json(await req('/report-templates', 'alice', 'POST', { name: 'mine', report_type: 'daily_summary' }), 201)).template;
    await json(await req('/report-templates/' + template.id, 'bob', 'DELETE'), 404);
    assert.deepEqual((await json(await req('/report-templates', 'bob'))).templates, []);
    await json(await req('/stores/suggestions/' + sid), 403);
    await json(await req('/stores/suggestions/' + sid + '/review', 'bob', 'POST', { action: 'approve_all' }), 403);
    await json(await req('/stores/executions', 'bob', 'POST', { suggestion_item_ids: [1] }), 403);
    const tasks = await json(await req('/stores/collect/tasks?date=2026-09-19')); assert.equal(tasks.tasks.length, 1); assert.equal(tasks.tasks[0].shop_id, 1);
    for (const url of ['/batch-operations', '/batch-operations/1/items', '/schedules', '/alerts', '/notification-channels']) await json(await req(url), 403);
  });
  await t.test('文件上传白名单、归属、访问链接及跨用户参考图被拒绝', async () => {
    const form = new FormData(); form.append('file', new Blob(['private file']), 'private.txt');
    const upload = await fetch(base + '/api/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + users.alice.token }, body: form });
    const file = await json(upload);
    assert.equal((await fetch(base + file.url)).status, 200);
    assert.equal((await fetch(base + file.url.split('?')[0])).status, 403);
    await json(await req('/images/generate', 'bob', 'POST', { prompt: 'test', mode: 'img2img', ref_image: file.url }), 403);
    const forbidden = new FormData(); forbidden.append('file', new Blob(['bad']), 'test.exe');
    await json(await fetch(base + '/api/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + users.alice.token }, body: forbidden }), 400);
    await json(await fetch(base + '/api/upload', { method: 'POST', body: form }), 401);
  });
  await t.test('降级管理员、重设密码及删除账号会立即更新登录权限', async () => {
    const token = users.admin.token;
    await run("UPDATE users SET role='member' WHERE id=? AND tenant_id=?", [users.admin.id, 1]);
    await json(await req('/auth/users', 'admin'), 403);
    await run("UPDATE users SET role='admin' WHERE id=? AND tenant_id=?", [users.admin.id, 1]);
    await run('UPDATE users SET session_version=session_version+1 WHERE id=? AND tenant_id=?', [users.admin.id, 1]);
    await json(await req('/auth/users', 'admin'), 401);
    users.admin.token = await signToken({ id: users.admin.id, tenant_id: 1 });
    await json(await req('/auth/users', 'admin'));
  });
  await t.test('SQLite 备份恢复及附件/报表校验；不覆盖现有目录', { skip: USE_PG ? 'PG 模式不适用（备份/恢复为 SQLite 专有）' : false }, async () => {
    const backup = path.join(root, 'backup');
    snapshot({ dbPath: process.env.DB_PATH, dataDir: process.env.DATA_DIR, uploadDir: process.env.UPLOAD_DIR, destination: backup });
    const target = restore(backup, path.join(root, 'restored'));
    const restored = new DatabaseSync(path.join(target, 'data/ecom-ai.db'), { readOnly: true });
    try {
      assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.equal(restored.prepare('SELECT COUNT(*) c FROM daily_reports').get().c, 3);
      const record = restored.prepare("SELECT * FROM report_records WHERE status='completed' LIMIT 1").get();
      assert.ok(fs.existsSync(path.join(target, 'data/reports', record.file_path)));
    } finally { restored.close(); }
    assert.throws(() => restore(backup, target), /禁止覆盖/);
    fs.appendFileSync(path.join(backup, 'ecom-ai.db'), 'corrupt');
    assert.throws(() => restore(backup, path.join(root, 'bad-restore')), /校验失败/);
  });
}));
