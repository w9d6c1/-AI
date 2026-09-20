// ===== 轻量指标（内存计数器 + 延迟直方图）=====
// 供 /api/health/metrics 暴露；进程级、无外部依赖。
const counters = new Map();
const gauges = new Map();
const histograms = new Map();

function key(name, labels) {
  if (!labels || !Object.keys(labels).length) return name;
  const parts = Object.keys(labels).sort().map(k => `${k}=${labels[k]}`);
  return `${name}{${parts.join(',')}}`;
}

function inc(name, labels, value = 1) {
  const k = key(name, labels);
  counters.set(k, (counters.get(k) || 0) + value);
}

function set(name, value, labels) {
  gauges.set(key(name, labels), Number(value));
}

function observe(name, ms, labels) {
  const k = key(name, labels);
  let h = histograms.get(k);
  if (!h) { h = { count: 0, sum: 0, max: 0, min: Infinity }; histograms.set(k, h); }
  h.count++; h.sum += ms; h.max = Math.max(h.max, ms); h.min = Math.min(h.min, ms);
}

function snapshot() {
  const hist = {};
  for (const [k, h] of histograms) {
    hist[k] = {
      count: h.count,
      avg_ms: h.count ? Math.round((h.sum / h.count) * 100) / 100 : 0,
      max_ms: h.max,
      min_ms: h.count ? h.min : 0
    };
  }
  return {
    counters: Object.fromEntries(counters),
    gauges: Object.fromEntries(gauges),
    histograms: hist,
    uptime_sec: Math.round(process.uptime()),
    memory_mb: Math.round(process.memoryUsage().rss / 1048576)
  };
}

function reset() { counters.clear(); gauges.clear(); histograms.clear(); }

module.exports = { inc, set, observe, snapshot, reset };
