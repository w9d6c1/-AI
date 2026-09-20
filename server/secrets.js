// ===== 密钥托管：支持 <NAME>_FILE（Docker/K8s secrets）=====
// 优先读取 <NAME>_FILE 指向的文件内容，其次环境变量 <NAME>。
const fs = require('fs');

function secret(name, fallback = '') {
  const fileVar = `${name}_FILE`;
  if (process.env[fileVar]) {
    try { return fs.readFileSync(process.env[fileVar], 'utf8').trim(); }
    catch (e) { throw new Error(`读取密钥文件失败 ${fileVar}: ${e.message}`); }
  }
  return process.env[name] !== undefined ? process.env[name] : fallback;
}

module.exports = { secret };
