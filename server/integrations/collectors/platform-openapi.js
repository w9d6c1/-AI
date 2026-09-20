// ===== 平台开放接口采集器（桩）=====
// 淘宝/京东/拼多多/抖音等需商家授权 + 开放平台应用密钥，此处仅保留接口位。
// 契约：{ id, platform, pull(ctx) -> raw, normalize(raw) -> { dailyReports, campaigns } }
const crypto = require('crypto');

const PLATFORMS = ['taobao', 'jd', 'pdd', 'douyin'];

function notImplemented(platform) {
  const err = new Error(`平台「${platform}」采集器尚未实现：需商家授权与开放平台应用密钥（阶段 3 接入）`);
  err.status = 501;
  err.code = 'COLLECTOR_NOT_IMPLEMENTED';
  return err;
}

// 开放平台签名占位：各平台算法不同（MD5/HMAC-SHA256），实现时按平台替换
function sign(params, secret, method = 'md5') {
  const base = Object.keys(params).sort().map(k => `${k}${params[k]}`).join('');
  const raw = secret + base + secret;
  return method === 'hmac-sha256'
    ? crypto.createHmac('sha256', secret).update(base).digest('hex')
    : crypto.createHash('md5').update(raw).digest('hex');
}

// 分页占位：实现时按平台游标/页码规则替换
async function fetchAllPages() {
  throw notImplemented('openapi');
}

// 限流占位：按平台 QPS 配额做令牌桶/重试
async function rateLimited() {
  throw notImplemented('openapi');
}

async function pull(ctx = {}) {
  throw notImplemented(ctx.platform || 'openapi');
}

function normalize() {
  return { dailyReports: [], campaigns: [] };
}

module.exports = { id: 'platform-openapi', platform: 'openapi', PLATFORMS, pull, normalize, sign, fetchAllPages, rateLimited };
