// ===== Webhook 通知适配器（钉钉/企微/飞书/通用）=====
// 契约：{ id, send(channel, context) -> true }
function buildPayload(channelType, context) {
  const text = context.text;
  if (channelType === 'dingtalk') return { msgtype: 'text', text: { content: text } };
  if (channelType === 'wecom') return { msgtype: 'text', text: { content: text } };
  if (channelType === 'feishu') return { msg_type: 'text', content: { text } };
  return { title: context.title, content: text, alert: context.alert };
}

async function send(channel, context) {
  if (!channel.webhook_url) throw new Error('未配置 webhook_url');
  const payload = buildPayload(channel.channel_type, context);
  const headers = { 'Content-Type': 'application/json' };
  if (channel.channel_type === 'feishu') headers['X-Request-Id'] = `alert_${Date.now()}`;
  const resp = await fetch(channel.webhook_url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000)
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json().catch(() => ({}));
  if (data.errcode && data.errcode !== 0) throw new Error(`渠道错误: ${data.errmsg}`);
  return true;
}

module.exports = { id: 'webhook', send, buildPayload };
