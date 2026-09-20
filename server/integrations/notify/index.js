// ===== 通知适配器注册表 =====
// 按 channel_type 路由到具体适配器；上层（notifier）只依赖统一契约。
const webhook = require('./webhook');
const email = require('./email');
const sms = require('./sms');

const ADAPTERS = [webhook, email, sms];
const byId = new Map(ADAPTERS.map(a => [a.id, a]));

const WEBHOOK_TYPES = new Set(['webhook', 'dingtalk', 'wecom', 'feishu']);

function get(id) {
  const a = byId.get(String(id || '').toLowerCase());
  if (!a) {
    const err = new Error(`未知通知适配器: ${id}`);
    err.status = 400;
    throw err;
  }
  return a;
}

function resolve(channelType) {
  if (channelType === 'email') return email;
  if (channelType === 'sms') return sms;
  if (WEBHOOK_TYPES.has(channelType)) return webhook;
  return webhook;
}

// 统一格式化告警文案，供各适配器复用
const SEVERITY = { critical: '🔴 严重', warning: '🟡 警告', info: '🔵 提示' };
function formatAlert(alert, shopName = '未知店铺') {
  const title = `${SEVERITY[alert.severity] || alert.severity} | ${alert.title}`;
  const text = `${title}\n店铺: ${shopName}\n时间: ${alert.triggered_at}\n详情: ${alert.message}`;
  return { title, text };
}

async function send(channel, context) {
  return resolve(channel.channel_type).send(channel, context);
}

function list() {
  return ADAPTERS.map(a => ({ id: a.id }));
}

module.exports = { get, resolve, send, formatAlert, list, ADAPTERS, webhook, email, sms };
