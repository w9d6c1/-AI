// ===== 执行器注册表 =====
// 默认人工执行；自动执行（RPA）默认关闭，需 EXECUTOR_DRIVER=rpa 且 AUTO_EXECUTE_ENABLED=true。
const manual = require('./manual');
const rpa = require('./rpa');

const EXECUTORS = [manual, rpa];
const byId = new Map(EXECUTORS.map(e => [e.id, e]));

const DRIVER = String(process.env.EXECUTOR_DRIVER || 'manual').toLowerCase();
const AUTO = process.env.AUTO_EXECUTE_ENABLED === 'true';

function get(id) {
  const e = byId.get(String(id || '').toLowerCase());
  if (!e) {
    const err = new Error(`未知执行器: ${id}`);
    err.status = 400;
    throw err;
  }
  return e;
}

// 当前生效执行器：未开启自动执行时一律人工
function active() {
  return DRIVER === 'rpa' && AUTO ? rpa : manual;
}

function autoEnabled() { return DRIVER === 'rpa' && AUTO; }

function describe() {
  return {
    driver: DRIVER,
    auto_execute_enabled: AUTO,
    active: active().id,
    executors: EXECUTORS.map(e => ({ id: e.id, supports: e.supports }))
  };
}

module.exports = { get, active, autoEnabled, describe, EXECUTORS, manual, rpa };
