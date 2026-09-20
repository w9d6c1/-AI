// ===== 短信通知适配器（桩）=====
// 需接入短信服务商（阿里云/腾讯云）后实现；当前明确抛错以便通知记录标记失败。
// 契约：{ id, send(channel, context) -> true }
async function send() {
  const err = new Error('短信渠道尚未接入（需配置短信服务商）');
  err.status = 501;
  err.code = 'NOTIFY_SMS_NOT_IMPLEMENTED';
  throw err;
}

module.exports = { id: 'sms', send };
