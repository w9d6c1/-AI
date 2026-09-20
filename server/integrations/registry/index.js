// ===== ProviderRegistry =====
// 按 priority 依次尝试；失败切换下一源；熔断跳过；记录用量成本。
const { providersFor, getProviders, reloadProviders } = require('./providers');
const breaker = require('./breaker');
const { recordUsage, getUsageStats } = require('./usage');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------- 对话 ----------
async function _chatOnce(provider, messages, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 90000);
  const model = opts.model || provider.model;
  try {
    const body = { model, messages, temperature: opts.temperature ?? 0.7, max_tokens: opts.maxTokens || 2000 };
    if (opts.responseFormat) body.response_format = opts.responseFormat;
    const reasoning = opts.reasoningEffort ?? provider.reasoningEffort;
    if (reasoning) body.reasoning_effort = reasoning;

    const resp = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      const err = new Error(`AI API ${resp.status}: ${errBody.slice(0, 300)}`);
      err.status = resp.status;
      err.retryable = resp.status === 429 || resp.status >= 500;
      throw err;
    }
    const data = await resp.json();
    return {
      content: data.choices?.[0]?.message?.content || '',
      tokensIn: data.usage?.prompt_tokens || 0,
      tokensOut: data.usage?.completion_tokens || 0,
      model: data.model || model
    };
  } finally {
    clearTimeout(timer);
  }
}

async function _chatProvider(provider, messages, opts) {
  const models = [opts.model || provider.model];
  if (provider.fallbackModel && !models.includes(provider.fallbackModel)) models.push(provider.fallbackModel);
  let lastError;
  for (const model of models) {
    for (let attempt = 0; attempt <= provider.maxRetries; attempt++) {
      if (attempt > 0) await sleep(Math.min(1000 * Math.pow(2, attempt - 1), 8000));
      try {
        return await _chatOnce(provider, messages, { ...opts, model });
      } catch (e) {
        lastError = e;
        if (!e.retryable || attempt === provider.maxRetries) break;
      }
    }
  }
  throw lastError || new Error('provider 调用失败');
}

async function callChat(messages, opts = {}) {
  const provs = providersFor('chat');
  if (!provs.length) throw new Error('无可用对话 provider（检查 AI_PROVIDERS 或 AI_API_KEY）');
  let lastErr;
  for (const p of provs) {
    if (await breaker.isOpen(p.id)) { console.warn(`[registry] ${p.id} 熔断中，跳过`); continue; }
    try {
      const r = await _chatProvider(p, messages, opts);
      await breaker.onSuccess(p.id);
      const cost = Math.round(((r.tokensIn / 1000) * p.priceIn + (r.tokensOut / 1000) * p.priceOut) * 10000) / 10000;
      await recordUsage({ provider: p.id, capability: 'chat', model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, priceIn: p.priceIn, priceOut: p.priceOut });
      return { content: r.content, provider: p.id, model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, cost };
    } catch (e) {
      lastErr = e;
      await breaker.onFailure(p.id);
      console.warn(`[registry] 对话源 ${p.id} 失败，尝试下一源:`, e.message);
    }
  }
  throw lastErr || new Error('全部对话 provider 失败');
}

// ---------- 生图 ----------
async function _imageOnce(provider, prompt, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 180000);
  try {
    const body = {
      model: opts.model || provider.imageModel,
      prompt,
      response_format: 'b64_json',
      size: opts.size || '2048x2048',
      watermark: opts.watermark === true
    };
    if (opts.image) body.image = opts.image;
    const resp = await fetch(`${provider.imageBaseUrl}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.imageApiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Image API ${resp.status}: ${text.slice(0, 300)}`);
    }
    const data = await resp.json();
    return (data.data || []).map(d => d.b64_json || d.url || '').filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
}

// 返回 { values: [b64/url...], provider }，按 provider 优先级选源
async function callImage(prompt, opts = {}) {
  const provs = providersFor('image');
  if (!provs.length) return { values: [], provider: null };
  let lastErr;
  for (const p of provs) {
    if (await breaker.isOpen(p.id)) continue;
    try {
      const values = await _imageOnce(p, prompt, opts);
      await breaker.onSuccess(p.id);
      await recordUsage({ provider: p.id, capability: 'image', model: p.imageModel, tokensIn: 0, tokensOut: 0, priceIn: p.priceIn, priceOut: p.priceOut });
      return { values, provider: p.id };
    } catch (e) {
      lastErr = e;
      await breaker.onFailure(p.id);
      console.warn(`[registry] 生图源 ${p.id} 失败，尝试下一源:`, e.message);
    }
  }
  throw lastErr || new Error('全部生图 provider 失败');
}

function hasCapability(cap) { return providersFor(cap).length > 0; }

function describe() {
  return getProviders().map(p => ({ id: p.id, priority: p.priority, caps: p.caps, chat_model: p.model, image_model: p.imageModel, has_chat_key: !!p.apiKey, has_image_key: !!p.imageApiKey }));
}

module.exports = { callChat, callImage, hasCapability, describe, reloadProviders, breaker, getUsageStats };
