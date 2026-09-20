// ===== 基线迁移 =====
// 现有 schema 由 server/db.js 以 CREATE TABLE IF NOT EXISTS 建立，此处仅登记基线，
// 后续迁移（多租户、数据模型扩展）在此基础上增量执行。
module.exports = {
  id: '0001_baseline',
  up: async () => {
    // no-op：标记当前 schema 为基线
  }
};
