// ===== 存储抽象入口 =====
// STORAGE_DRIVER=local(默认) | s3；规范 URL 统一为 /uploads/<key>。
const driver = (process.env.STORAGE_DRIVER || 'local').toLowerCase();
const impl = driver === 's3' ? require('./s3') : require('./local');

module.exports = {
  driver,
  put: impl.put,
  del: impl.del,
  // 契约别名（§10）：delete(key)
  delete: impl.del,
  getSignedUrl: impl.getSignedUrl,
  localPath: impl.localPath,
  isLocal: impl.isLocal,
  ensureBucket: impl.ensureBucket || (async () => {}),
  ping: impl.ping || (async () => ({ ok: true, driver }))
};
