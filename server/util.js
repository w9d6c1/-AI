// ===== 通用工具：本地时区日期（Asia/Shanghai）=====
// 说明：统一使用运行环境本地时区（生产容器设置 TZ=Asia/Shanghai），
// 避免 toISOString() 的 UTC 跨天问题。

function pad(n) {
  return String(n).padStart(2, '0');
}

// 返回 Date 对应的本地日期字符串 YYYY-MM-DD
function dateLocal(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 今天（本地）
function todayLocal() {
  return dateLocal(new Date());
}

// 相对今天偏移 days 天（负数为过去）的本地日期字符串
function dateLocalOffset(days, base = new Date()) {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return dateLocal(d);
}

// 本地日期时间字符串 YYYY-MM-DD HH:mm:ss（与 datetime('now','localtime') 对齐）
function nowLocal(d = new Date()) {
  return `${dateLocal(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 并发受限映射：按 limit 个并发处理 items，保持结果顺序；单条异常不影响其它项。
// 用于采集/执行等批量循环（替代串行 await，避免 50 店线性增长）。
async function mapLimit(items, limit, fn) {
  const list = Array.from(items || []);
  const size = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));
  const results = new Array(list.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= list.length) return;
      results[i] = await fn(list[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, list.length) }, worker));
  return results;
}

// 读取并发上限环境变量（默认 fallback）
function concurrency(envKey, fallback = 5) {
  const n = Number(process.env[envKey]);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.trunc(n), 50) : fallback;
}

module.exports = { dateLocal, todayLocal, dateLocalOffset, nowLocal, mapLimit, concurrency };
