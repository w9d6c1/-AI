// ===== Provider 配置解析 =====
// AI_PROVIDERS(JSON) 定义多源；未配置时回退现有单源 AI_* 环境变量（向后兼容）。
// 密钥用 apiKeyEnv 引用环境变量名，避免明文写入配置。

function normalize(p, i) {
  const caps = Array.isArray(p.caps) && p.caps.length ? p.caps : ['chat'];
  const baseUrl = p.baseUrl || process.env.AI_BASE_URL || '';
  const apiKey = p.apiKeyEnv ? (process.env[p.apiKeyEnv] || '') : (p.apiKey || '');
  const imageApiKey = p.imageApiKeyEnv ? (process.env[p.imageApiKeyEnv] || apiKey) : (p.imageApiKey || apiKey);
  return {
    id: p.id || ('p' + (i + 1)),
    priority: Number(p.priority) || (i + 1),
    caps,
    baseUrl,
    apiKey,
    model: p.model || '',
    fallbackModel: p.fallbackModel || '',
    imageBaseUrl: p.imageBaseUrl || baseUrl,
    imageApiKey,
    imageModel: p.imageModel || '',
    reasoningEffort: p.reasoningEffort ?? (process.env.AI_REASONING_EFFORT || ''),
    maxRetries: Number(p.maxRetries ?? process.env.AI_MAX_RETRIES ?? 3),
    priceIn: Number(p.priceIn || 0),
    priceOut: Number(p.priceOut || 0)
  };
}

function loadProviders() {
  const raw = process.env.AI_PROVIDERS;
  let list = null;
  if (raw) {
    try { list = JSON.parse(raw); } catch (e) { console.warn('[registry] AI_PROVIDERS 解析失败，回退单源:', e.message); }
  }
  if (!Array.isArray(list) || !list.length) {
    list = [{
      id: 'default',
      priority: 1,
      caps: ['chat', 'image'],
      baseUrl: process.env.AI_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3',
      apiKeyEnv: 'AI_API_KEY',
      model: process.env.AI_MODEL || 'doubao-pro-32k',
      fallbackModel: process.env.AI_FALLBACK_MODEL || '',
      imageBaseUrl: process.env.AI_IMAGE_BASE_URL || process.env.AI_BASE_URL,
      imageApiKeyEnv: 'AI_IMAGE_API_KEY',
      imageModel: process.env.AI_IMAGE_MODEL || 'doubao-seedream-3-0-t2i'
    }];
  }
  return list.map(normalize).sort((a, b) => a.priority - b.priority);
}

let cache = null;
function getProviders() {
  if (!cache) cache = loadProviders();
  return cache;
}

function providersFor(cap) {
  return getProviders().filter(p => p.caps.includes(cap) && (
    cap === 'chat' ? (p.baseUrl && p.apiKey) : (p.imageBaseUrl && p.imageApiKey)
  ));
}

function reloadProviders() { cache = null; }

module.exports = { getProviders, providersFor, reloadProviders, normalize };
