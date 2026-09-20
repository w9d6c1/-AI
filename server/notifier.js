// ===== 通知推送服务 =====
// 通过通知适配器（webhook/email/sms）分发；渠道类型由 notification_channels.channel_type 决定。
const { repos } = require('./repositories');
const { requireTenant } = require('./repositories/tenant-context');
const { nowLocal } = require('./util');
const notify = require('./integrations/notify');

// 兼容旧调用：构建 webhook 文本载荷
function buildWebhookPayload(channel, alert) {
  const { text, title } = notify.formatAlert(alert, alert.shop_name || '未知店铺');
  return notify.webhook.buildPayload(channel.channel_type, { title, text, alert });
}

// 渠道优先级（§4：webhook → 邮件 → 短信）；failover 模式下按此顺序降级
const TYPE_ORDER = { webhook: 0, dingtalk: 0, wecom: 0, feishu: 0, email: 1, sms: 2 };
function notifyMode() { return String(process.env.NOTIFY_MODE || 'fanout').toLowerCase() === 'failover' ? 'failover' : 'fanout'; }
function orderChannels(channels) {
  return [...channels].sort((a, b) => (TYPE_ORDER[a.channel_type] ?? 9) - (TYPE_ORDER[b.channel_type] ?? 9) || a.id - b.id);
}

async function sendNotifications(alertId) {
  const t = requireTenant();
  const alert = await repos.adapter.get('SELECT * FROM alerts WHERE id=? AND tenant_id=?', [alertId, t]);
  if (!alert) return;
  const channels = await repos.adapter.all('SELECT * FROM notification_channels WHERE enabled=1 AND tenant_id=?', [t]);
  if (!channels.length) return;

  const shop = alert.shop_id
    ? await repos.adapter.get('SELECT shop_name FROM shops WHERE id=? AND tenant_id=?', [alert.shop_id, t])
    : null;
  const context = notify.formatAlert(alert, shop ? shop.shop_name : '未知店铺');
  const mode = notifyMode();
  const ordered = orderChannels(channels);
  let delivered = false;

  for (const ch of ordered) {
    if (mode === 'failover' && delivered) break; // 已成功投递，停止降级
    const sentAt = nowLocal();
    try {
      await notify.send(ch, { ...context, alert });
      await repos.adapter.run('INSERT INTO notifications (alert_id, channel_id, status, error_msg, sent_at, tenant_id) VALUES (?,?,?,?,?,?)', [alertId, ch.id, 'sent', null, sentAt, t]);
      if (mode === 'failover') delivered = true;
    } catch (e) {
      await repos.adapter.run('INSERT INTO notifications (alert_id, channel_id, status, error_msg, sent_at, tenant_id) VALUES (?,?,?,?,?,?)', [alertId, ch.id, 'failed', e.message, sentAt, t]);
      console.error(`[notifier] 渠道 ${ch.name} 发送失败:`, e.message);
    }
  }
}

async function resendNotifications(alertId) {
  const t = requireTenant();
  await repos.adapter.run('DELETE FROM notifications WHERE alert_id=? AND tenant_id=?', [alertId, t]);
  await sendNotifications(alertId);
}

module.exports = { sendNotifications, resendNotifications, buildWebhookPayload };
