const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const net = require('node:net');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecom-stage2-'));
Object.assign(process.env, {
  DATA_DIR: path.join(root, 'data'), DB_PATH: path.join(root, 'data/ecom-ai.db'), UPLOAD_DIR: path.join(root, 'uploads'),
  JWT_SECRET: crypto.randomBytes(32).toString('hex'), RPA_CALLBACK_TOKEN: 'stage2-callback-token',
  DB_DRIVER: 'sqlite', RPA_MOCK_MODE: 'true', EXECUTOR_DRIVER: 'manual', AUTO_EXECUTE_ENABLED: 'false',
  QUEUE_ENABLED: 'false', STORAGE_DRIVER: 'local', ENABLE_SCHEDULER: 'false',
  SEED_DEFAULT_USERS: 'false', SEED_DEMO_DATA: 'false', ALLOW_REGISTRATION: 'false',
  // 避免 dotenv 载入真实 .env 的密钥后触发真实 LLM 调用（保持测试隔离）
  AI_API_KEY: '', AI_IMAGE_API_KEY: '', AI_PROVIDERS: ''
});

const app = require('../server/index');
const { defaultAdapter } = require('../server/repositories');
const { runWithTenant } = require('../server/repositories/tenant-context');
const { signToken } = require('../server/middleware');
const { db } = require('../server/db');
const { parseCsv, toCsv } = require('../server/csv');
const { mapLimit } = require('../server/util');
const csvCollector = require('../server/integrations/collectors/csv');
const collectors = require('../server/integrations/collectors');
const executors = require('../server/integrations/executors');
const notify = require('../server/integrations/notify');
const { sendNotifications } = require('../server/notifier');
const { triggerCollection, triggerExecution } = require('../server/rpa');

let server, base, token, adminId, shopId, shop2Id, itemIds = [];

before(async () => {
  await runWithTenant(1, async () => {
    adminId = (await defaultAdapter.run('INSERT INTO users (tenant_id,username,password_hash,role) VALUES (?,?,?,?)', [1, 'admin', bcrypt.hashSync('x', 4), 'admin'])).lastInsertRowid;
    shopId = (await defaultAdapter.run('INSERT INTO shops (tenant_id,shop_name,qianniu_account) VALUES (?,?,?)', [1, '测试店', 'qn_demo'])).lastInsertRowid;
    shop2Id = (await defaultAdapter.run('INSERT INTO shops (tenant_id,shop_name,qianniu_account) VALUES (?,?,?)', [1, '测试店2', 'qn_demo2'])).lastInsertRowid;
    await defaultAdapter.run('UPDATE shops SET daily_adjust_limit=? WHERE tenant_id=?', [50, 1]);
    token = await signToken({ id: adminId, tenant_id: 1, session_version: 0 });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});

after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  try { db.close(); } catch (_) { /* ignore */ }
  const resolved = path.resolve(root);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('ecom-stage2-')) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

async function req(url, method = 'GET', body, headers = {}) {
  const h = { Authorization: 'Bearer ' + token, ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  return fetch(base + '/api' + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
}

test('CSV 解析：引号/逗号/换行/BOM', () => {
  const text = '\uFEFFa,b,c\r\n"x,1","y\n2",3\r\n"he said ""hi""",,z\n';
  const { headers, records } = parseCsv(text);
  assert.deepEqual(headers, ['a', 'b', 'c']);
  assert.equal(records.length, 2);
  assert.equal(records[0].a, 'x,1');
  assert.equal(records[0].b, 'y\n2');
  assert.equal(records[1].a, 'he said "hi"');
  assert.equal(records[1].c, 'z');
  assert.equal(toCsv([{ a: 'x,y' }], ['a']), 'a\r\n"x,y"\r\n');
});

test('并发工具 mapLimit：保序、限并发、单条异常不影响其它', async () => {
  let active = 0, peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
    active++; peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 5));
    active--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10]);
  assert.ok(peak <= 2, `peak=${peak}`);
});

test('采集器注册表与 CSV 采集器契约', () => {
  assert.equal(collectors.get('csv').id, 'csv');
  assert.ok(collectors.list().some(c => c.id === 'platform-openapi'));
  assert.throws(() => collectors.get('nope'), /未知采集器/);

  const tpl = csvCollector.template('daily_report');
  assert.ok(tpl.includes('千牛账号'));
  assert.ok(tpl.includes('qianniu_demo'));

  const raw = csvCollector.pull({ buffer: Buffer.from('shop_qianniu_account,report_date,campaign_id,campaign_name,cost,impressions,clicks\nqn_demo,2026-09-20,c1,计划,10,100,5\n') });
  assert.equal(raw.type, 'ad_campaign');
  assert.deepEqual(csvCollector.validateRecords(raw.records, 'ad_campaign'), []);
  const norm = csvCollector.normalize(raw);
  assert.equal(norm.campaigns.length, 1);
  assert.equal(norm.campaigns[0].cost, 10);

  // 中文标签模板可回读
  const zh = csvCollector.pull({ buffer: Buffer.from(csvCollector.template('ad_campaign')) });
  assert.equal(zh.type, 'ad_campaign');
  assert.deepEqual(csvCollector.validateRecords(zh.records, 'ad_campaign'), []);
});

test('CSV 导入：入库 + 导入报告；坏行返回 422 与错误明细', async () => {
  await runWithTenant(1, async () => {
    const good = 'shop_qianniu_account,report_date,visitors,pay_amount\nqn_demo,2026-09-20,1000,5000\n';
    const r = await csvCollector.importBuffer({ buffer: Buffer.from(good), fileName: 'd.csv', type: 'auto', userId: adminId });
    assert.equal(r.status, 'success');
    assert.equal(r.success, 1);
    assert.equal(r.total, 1);
    const row = await defaultAdapter.get('SELECT * FROM daily_reports WHERE tenant_id=? AND shop_id=? AND report_date=?', [1, shopId, '2026-09-20']);
    assert.equal(Number(row.visitors), 1000);
    assert.equal(Number(row.pay_amount), 5000);
    const batch = await defaultAdapter.get('SELECT * FROM import_batches WHERE id=? AND tenant_id=?', [r.batchId, 1]);
    assert.equal(batch.status, 'success');
  });

  const bad = 'shop_qianniu_account,report_date,visitors\nqn_demo,2026-13-40,abc\n';
  const form = new FormData();
  form.append('file', new Blob([bad], { type: 'text/csv' }), 'bad.csv');
  const resp = await fetch(base + '/api/stores/import/csv', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form });
  assert.equal(resp.status, 422);
  const body = await resp.json();
  assert.equal(body.report.status, 'failed');
  assert.ok(body.report.errors.length >= 1);
});

test('导入模板下载与批次查询（API）', async () => {
  const tpl = await req('/stores/import/template?type=ad_campaign');
  assert.equal(tpl.status, 200);
  assert.ok((await tpl.text()).includes('计划ID'));
  const batches = await (await req('/stores/import/batches')).json();
  assert.ok(Array.isArray(batches.batches));
  assert.ok(batches.batches.length >= 1);
});

test('执行器注册表：默认人工，自动执行关闭', () => {
  const d = executors.describe();
  assert.equal(d.active, 'manual');
  assert.equal(d.auto_execute_enabled, false);
  assert.equal(executors.active().id, 'manual');
});

test('人工执行：置为待人工并可通过 API 回填 actual_value', async () => {
  let execId;
  await runWithTenant(1, async () => {
    execId = (await defaultAdapter.run("INSERT INTO executions (tenant_id,shop_id,action_type,target_campaign_id,status) VALUES (?,?,?,?,?)", [1, shopId, 'adjust_price', 'c1', 'queued'])).lastInsertRowid;
    const r = await executors.active().execute({ executionId: execId, shopId, qianniuAccount: 'qn_demo', campaignId: 'c1', action: 'adjust_price', targetValue: 10 });
    assert.equal(r.executor, 'manual');
    const row = await defaultAdapter.get('SELECT status FROM executions WHERE id=? AND tenant_id=?', [execId, 1]);
    assert.equal(row.status, 'pending_manual');
  });

  const exp = await req('/stores/executions/export?status=pending_manual');
  assert.equal(exp.status, 200);
  assert.ok((await exp.text()).includes(String(execId)));

  const back = await req('/stores/executions/' + execId + '/backfill', 'POST', { status: 'success', actual_value: 9.5 });
  assert.equal(back.status, 200);
  const updated = (await back.json()).execution;
  assert.equal(updated.status, 'success');
  assert.equal(Number(updated.actual_value), 9.5);
});

test('通知适配器：格式化/webhook 载荷/短信桩/邮件缺配置', async () => {
  const ctx = notify.formatAlert({ severity: 'critical', title: '烧钱', triggered_at: '2026-09-20 10:00:00', message: 'ROI<1' }, '测试店');
  assert.ok(ctx.title.includes('严重'));
  assert.ok(ctx.text.includes('测试店'));
  const payload = notify.webhook.buildPayload('dingtalk', ctx);
  assert.equal(payload.msgtype, 'text');
  await assert.rejects(() => notify.sms.send({}, ctx), /尚未接入/);
  await assert.rejects(() => notify.email.send({ email_to: 'a@b.com' }, ctx), /SMTP/);
});

test('通知服务：按渠道分发 webhook/短信，记录 sent/failed', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({}) });
  try {
    await runWithTenant(1, async () => {
      const alertId = (await defaultAdapter.run('INSERT INTO alerts (tenant_id,shop_id,alert_type,severity,title,message,triggered_at) VALUES (?,?,?,?,?,?,?)', [1, shopId, 'test', 'warning', '测试预警', 'msg', '2026-09-20 10:00:00'])).lastInsertRowid;
      await defaultAdapter.run('INSERT INTO notification_channels (tenant_id,name,channel_type,webhook_url,enabled) VALUES (?,?,?,?,?)', [1, '钩子', 'dingtalk', 'https://hook.example/x', 1]);
      await defaultAdapter.run('INSERT INTO notification_channels (tenant_id,name,channel_type,enabled) VALUES (?,?,?,?)', [1, '短信', 'sms', 1]);
      await sendNotifications(alertId);
      const rows = await defaultAdapter.all('SELECT status FROM notifications WHERE tenant_id=? AND alert_id=?', [1, alertId]);
      assert.equal(rows.length, 2);
      assert.ok(rows.some(r => r.status === 'sent'));
      assert.ok(rows.some(r => r.status === 'failed'));
    });
  } finally { global.fetch = orig; }
});

test('接口：采集触发返回 job 列表（不再只回「采集完成」）', async () => {
  const resp = await req('/stores/collect/trigger?date=2026-09-21', 'POST');
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.ok(Array.isArray(body.jobs));
  assert.ok(body.jobs.length >= 2);
  const job = body.jobs.find(j => j.shop_id === shopId);
  assert.ok(job.job_id && job.job_id.startsWith('mock_job_'));
  assert.equal(job.status, 'success');
});

test('B8/接口：跨店铺并发创建执行（人工待处理），对账可判定', async () => {
  await runWithTenant(1, async () => {
    const s1 = (await defaultAdapter.run('INSERT INTO suggestions (tenant_id,shop_id,suggestion_date) VALUES (?,?,?)', [1, shopId, '2026-09-21'])).lastInsertRowid;
    const i1 = (await defaultAdapter.run("INSERT INTO suggestion_items (tenant_id,suggestion_id,campaign_id,action_type,current_value,suggested_value,status) VALUES (?,?,?,?,?,?,?)", [1, s1, 'c1', 'adjust_price', 10, 12, 'approved'])).lastInsertRowid;
    const s2 = (await defaultAdapter.run('INSERT INTO suggestions (tenant_id,shop_id,suggestion_date) VALUES (?,?,?)', [1, shop2Id, '2026-09-21'])).lastInsertRowid;
    const i2 = (await defaultAdapter.run("INSERT INTO suggestion_items (tenant_id,suggestion_id,campaign_id,action_type,current_value,suggested_value,status) VALUES (?,?,?,?,?,?,?)", [1, s2, 'c1', 'pause', null, null, 'approved'])).lastInsertRowid;
    itemIds = [i1, i2];
  });

  const resp = await req('/stores/executions', 'POST', { suggestion_item_ids: itemIds });
  assert.equal(resp.status, 200);
  const executions = (await resp.json()).executions;
  assert.equal(executions.length, 2);
  assert.ok(executions.every(e => e.status === 'pending_manual' && e.executor === 'manual'));

  const execId = executions[0].id;
  const before = await (await req('/stores/executions/' + execId + '/reconcile')).json();
  assert.equal(before.reconcile.expected_value, 12);
  assert.equal(before.reconcile.matched, null);

  await req('/stores/executions/' + execId + '/backfill', 'POST', { status: 'success', actual_value: 12 });
  const after = await (await req('/stores/executions/' + execId + '/reconcile')).json();
  assert.equal(after.reconcile.actual_value, 12);
  assert.equal(after.reconcile.matched, true);
});

test('邮件适配器：SMTP 会话成功发送（本地 mock 服务器）', async () => {
  const received = [];
  const smtp = net.createServer(socket => {
    socket.write('220 mock ESMTP\r\n');
    let buf = '';
    let inData = false;
    socket.on('data', chunk => {
      buf += chunk.toString('utf8');
      while (true) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end === -1) return;
          buf = buf.slice(end + 5);
          inData = false;
          socket.write('250 OK queued\r\n');
          continue;
        }
        const idx = buf.indexOf('\r\n');
        if (idx === -1) return;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        received.push(line);
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO')) socket.write('250-mock\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (cmd.startsWith('AUTH')) socket.write('235 ok\r\n');
        else if (cmd === 'DATA') { inData = true; socket.write('354 go\r\n'); }
        else if (cmd.startsWith('QUIT')) { socket.write('221 bye\r\n'); socket.end(); }
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise(r => smtp.listen(0, '127.0.0.1', r));
  const port = smtp.address().port;
  const keys = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_FROM', 'SMTP_USER', 'SMTP_PASS', 'SMTP_SECURE'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_FROM: 'bot@test.local', SMTP_USER: '', SMTP_PASS: '', SMTP_SECURE: 'false' });
  try {
    const ok = await notify.email.send({ email_to: 'ops@test.local' }, { title: '测试', text: 'hello' });
    assert.equal(ok, true);
    assert.ok(received.some(l => l.startsWith('MAIL FROM')), received.join('|'));
    assert.ok(received.some(l => l.startsWith('RCPT TO')), received.join('|'));
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await new Promise(r => smtp.close(r));
  }
});

test('B1/B5：Mock 采集/执行回写 rpa_job_id', async () => {
  await runWithTenant(1, async () => {
    await defaultAdapter.run("INSERT INTO collection_tasks (tenant_id,shop_id,task_date,status) VALUES (?,?,?,?)", [1, shopId, '2026-09-18', 'queued']);
    const r = await triggerCollection(shopId, 'qn_demo', '2026-09-18');
    assert.ok(r.jobId.startsWith('mock_job_'));
    const task = await defaultAdapter.get('SELECT * FROM collection_tasks WHERE tenant_id=? AND shop_id=? AND task_date=?', [1, shopId, '2026-09-18']);
    assert.equal(task.status, 'success');
    assert.equal(task.rpa_job_id, r.jobId);

    const execId = (await defaultAdapter.run("INSERT INTO executions (tenant_id,shop_id,action_type,target_campaign_id,status) VALUES (?,?,?,?,?)", [1, shopId, 'pause', 'c2', 'queued'])).lastInsertRowid;
    const jobId = await triggerExecution(execId, shopId, 'qn_demo', 'c2', 'pause', 0);
    assert.ok(jobId.startsWith('mock_exec_'));
    const ex = await defaultAdapter.get('SELECT rpa_job_id, status FROM executions WHERE id=? AND tenant_id=?', [execId, 1]);
    assert.equal(ex.rpa_job_id, jobId);
    assert.equal(ex.status, 'success');
  });
});

test('RPA 回调：无 token 拒绝；采集回调按 shop+日期兜底命中并写数据', async () => {
  let taskId;
  await runWithTenant(1, async () => {
    taskId = (await defaultAdapter.run("INSERT INTO collection_tasks (tenant_id,shop_id,task_date,status,rpa_job_id) VALUES (?,?,?,?,?)", [1, shopId, '2026-09-17', 'running', 'job-xyz'])).lastInsertRowid;
  });

  const noToken = await fetch(base + '/api/rpa/callback/collect', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'collect_daily_report', job_id: 'job-xyz' })
  });
  assert.equal(noToken.status, 401);

  // job_id 与库中不同，仅提供 shop_id + report_date，验证兜底命中
  const resp = await fetch(base + '/api/rpa/callback/collect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-callback-token': 'stage2-callback-token' },
    body: JSON.stringify({ event: 'collect_daily_report', job_id: 'job-other', shop_id: shopId, report_date: '2026-09-17', status: 'success', data: { visitors: 777, payed_buyer_count: 7, pay_amount: 700, pay_item_count: 8, conversion_rate: 0.01, avg_unit_price: 100 } })
  });
  assert.equal(resp.status, 200);
  await runWithTenant(1, async () => {
    const task = await defaultAdapter.get('SELECT * FROM collection_tasks WHERE id=? AND tenant_id=?', [taskId, 1]);
    assert.equal(task.status, 'success');
    const report = await defaultAdapter.get('SELECT * FROM daily_reports WHERE tenant_id=? AND shop_id=? AND report_date=?', [1, shopId, '2026-09-17']);
    assert.equal(Number(report.visitors), 777);
  });
});

test('RPA 回调：执行回传 actual_value 与截图', async () => {
  let execId;
  await runWithTenant(1, async () => {
    execId = (await defaultAdapter.run("INSERT INTO executions (tenant_id,shop_id,action_type,target_campaign_id,status,rpa_job_id) VALUES (?,?,?,?,?,?)", [1, shopId, 'pause', 'c9', 'running', 'exec-job-1'])).lastInsertRowid;
  });
  const resp = await fetch(base + '/api/rpa/callback/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-callback-token': 'stage2-callback-token' },
    body: JSON.stringify({ job_id: 'exec-job-1', status: 'success', screenshot_url: '/uploads/shot.png', actual_value: 1.23 })
  });
  assert.equal(resp.status, 200);
  await runWithTenant(1, async () => {
    const ex = await defaultAdapter.get('SELECT * FROM executions WHERE id=? AND tenant_id=?', [execId, 1]);
    assert.equal(ex.status, 'success');
    assert.equal(Number(ex.actual_value), 1.23);
    assert.equal(ex.screenshot_url, '/uploads/shot.png');
  });
});
