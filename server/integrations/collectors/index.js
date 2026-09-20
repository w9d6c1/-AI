// ===== 采集器注册表 =====
// 按 id/platform 选择采集器；上层仅依赖统一契约，不感知具体实现。
const csv = require('./csv');
const platformOpenapi = require('./platform-openapi');
const rpa = require('./rpa');

const COLLECTORS = [csv, platformOpenapi, rpa];
const byId = new Map(COLLECTORS.map(c => [c.id, c]));

function get(id) {
  const c = byId.get(String(id || '').toLowerCase());
  if (!c) {
    const err = new Error(`未知采集器: ${id}`);
    err.status = 400;
    throw err;
  }
  return c;
}

// 默认采集器：优先 CSV（真实数据零依赖），RPA 仅在非 Mock 时作为候选
function defaultCollector() {
  return csv;
}

function list() {
  return COLLECTORS.map(c => ({ id: c.id, platform: c.platform }));
}

module.exports = { get, list, defaultCollector, COLLECTORS, csv, platformOpenapi, rpa };
