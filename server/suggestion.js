// ===== AI 建议引擎 — 调 DeepSeek/豆包生成每店每日建议单，API 不可用时降级硬规则 =====
const { repos } = require('./repositories');
const { fetchLLMDetailed, aiEnabled } = require('./ai');
const { todayLocal, dateLocalOffset } = require('./util');
const { requireTenant } = require('./repositories/tenant-context');

// 建议 Prompt 版本（变更 prompt/规则时递增，落库以便追溯）
const SUGGEST_PROMPT_VERSION = 'suggest-v2';

// 置信度阈值：低于阈值且非 no_change 的建议项被剔除（可配置）
function minConfidence() {
  const n = Number(process.env.SUGGEST_MIN_CONFIDENCE);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.6;
}

const SYSTEM_PROMPT = `你是一个淘宝万象台广告投放优化专家。根据店铺当日广告计划数据，为每个广告计划给出操作建议。
返回严格 JSON 格式：
{
  "shop_summary": "店铺当日总览分析（2~3句话）",
  "items": [
    { "campaign_id": "计划ID", "action_type": "adjust_price|pause|add_budget|no_change", "suggested_value": 数字或null, "reason": "理由", "confidence": 0.0~1.0 }
  ]
}
判断规则：ROI<1且连续3天→pause；ROI 1~1.5且花费高于均值→降价20%→adjust_price；ROI>3且展现量低→加预算20%→add_budget；其余→no_change`;

const VALID_ACTIONS = ['adjust_price', 'pause', 'add_budget', 'no_change'];

function parseJsonLoose(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { /* ignore */ }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch (e) { /* ignore */ } }
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) { try { return JSON.parse(brace[0]); } catch (e) { /* ignore */ } }
  return null;
}

// 输出 schema 校验：过滤非法项并规范化字段
function validateSuggestionOutput(parsed, validIds) {
  if (!parsed || typeof parsed !== 'object') return { ok: false, items: [], errors: ['输出不是 JSON 对象'] };
  const errors = [];
  if (!Array.isArray(parsed.items)) return { ok: false, items: [], errors: ['items 不是数组'] };
  const items = [];
  for (const it of parsed.items) {
    if (!it || typeof it !== 'object') { errors.push('item 非对象'); continue; }
    if (!validIds.has(it.campaign_id)) { errors.push(`未知 campaign_id: ${it.campaign_id}`); continue; }
    if (!VALID_ACTIONS.includes(it.action_type)) { errors.push(`非法 action_type: ${it.action_type}`); continue; }
    const confidence = Math.max(0, Math.min(1, Number(it.confidence) || 0.5));
    items.push({
      campaign_id: it.campaign_id,
      action_type: it.action_type,
      suggested_value: (typeof it.suggested_value === 'number' && isFinite(it.suggested_value)) ? it.suggested_value : null,
      reason: String(it.reason || '').slice(0, 300),
      confidence
    });
  }
  return { ok: items.length > 0, items, errors };
}

async function generateSuggestions(targetDate) {
  const t = requireTenant();
  const date = targetDate || todayLocal();
  const shops = await repos.adapter.all("SELECT * FROM shops WHERE status='active' AND tenant_id=?", [t]);

  const pending = [];
  for (const shop of shops) {
    const existing = await repos.adapter.get('SELECT id FROM suggestions WHERE shop_id=? AND suggestion_date=? AND tenant_id=?', [shop.id, date, t]);
    if (existing) continue;
    const campaigns = await repos.adapter.all('SELECT * FROM ad_campaigns WHERE shop_id=? AND report_date=? AND tenant_id=?', [shop.id, date, t]);
    if (campaigns.length === 0) continue;
    pending.push({ shop, campaigns });
  }

  const limit = Math.max(1, parseInt(process.env.SUGGEST_CONCURRENCY || '4', 10));
  let count = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < pending.length) {
      const { shop, campaigns } = pending[cursor++];
      try {
        await generateForShop(shop, campaigns, date);
        count++;
      } catch (e) {
        console.warn(`[Suggestion] 店铺「${shop.shop_name}」生成失败:`, e.message);
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, pending.length) }, () => worker());
  await Promise.all(workers);
  return count;
}

async function generateForShop(shop, campaigns, targetDate) {
  const t = requireTenant();
  const history = await repos.adapter.all(
    'SELECT * FROM ad_campaigns WHERE shop_id=? AND report_date>=? AND report_date<? AND tenant_id=?',
    [shop.id, dateLocalOffset(-7, new Date(targetDate + 'T00:00:00')), targetDate, t]
  );

  let aiResult;
  let source = 'rule';
  if (aiEnabled()) {
    try {
      aiResult = await _llmSuggest(shop, campaigns, history);
      source = 'llm';
    } catch (e) {
      console.warn('[Suggestion] AI 调用失败，降级硬规则:', e.message);
      aiResult = _ruleBased(shop, campaigns, history);
    }
  } else {
    aiResult = _ruleBased(shop, campaigns, history);
  }

  // 置信度阈值：剔除低置信度的可执行建议（no_change 始终保留）
  const threshold = minConfidence();
  const all = aiResult.items || [];
  const kept = all.filter(i => i.action_type === 'no_change' || (i.confidence ?? 0.5) >= threshold);
  const excluded = all.length - kept.length;

  const info = await repos.adapter.run(
    'INSERT INTO suggestions (shop_id, suggestion_date, ai_summary, status, tenant_id, prompt_version, model, source, excluded_items) VALUES (?,?,?,?,?,?,?,?,?)',
    [shop.id, targetDate, aiResult.shop_summary, 'pending', t, SUGGEST_PROMPT_VERSION, aiResult.model || null, source, excluded]
  );
  const suggestionId = info.lastInsertRowid;

  for (const item of kept) {
    const campaign = campaigns.find(c => c.campaign_id === item.campaign_id);
    if (!campaign) continue;
    await repos.adapter.run(
      'INSERT INTO suggestion_items (suggestion_id, campaign_id, action_type, current_value, suggested_value, reason, confidence, status, tenant_id) VALUES (?,?,?,?,?,?,?,?,?)',
      [suggestionId, item.campaign_id, item.action_type, campaign.cpc, item.suggested_value ?? null, item.reason || '', item.confidence ?? 0.5, 'pending', t]
    );
  }
}

async function _llmSuggest(shop, campaigns, history) {
  const campaignData = campaigns.map(c => ({
    campaign_id: c.campaign_id, campaign_name: c.campaign_name, cost: c.cost,
    impressions: c.impressions, clicks: c.clicks, ctr: c.ctr, cpc: c.cpc,
    pay_amount: c.pay_amount, roi: c.roi, status: c.status
  }));
  const historyData = {};
  history.forEach(h => {
    if (!historyData[h.campaign_id]) historyData[h.campaign_id] = [];
    historyData[h.campaign_id].push({ date: h.report_date, roi: h.roi, cost: h.cost });
  });

  const userMsg = `店铺：${shop.shop_name}\n当日计划数据：${JSON.stringify(campaignData)}\n近7天历史：${JSON.stringify(historyData)}`;

  const detail = await fetchLLMDetailed([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMsg }
  ], { temperature: 0.2, maxTokens: 3000, responseFormat: { type: 'json_object' } });

  const parsed = parseJsonLoose(detail.content);
  const validIds = new Set(campaigns.map(c => c.campaign_id));
  const v = validateSuggestionOutput(parsed, validIds);
  if (!v.ok) throw new Error('LLM 返回格式不正确: ' + v.errors.slice(0, 3).join('; '));

  return {
    shop_summary: String((parsed && parsed.shop_summary) || `${shop.shop_name}当日建议已生成。`).slice(0, 500),
    items: v.items,
    model: detail.model || null,
    provider: detail.provider || null,
    tokensIn: detail.tokensIn || 0,
    tokensOut: detail.tokensOut || 0,
    cost: detail.cost || 0
  };
}

function _ruleBased(shop, campaigns, history) {
  const avgCost = campaigns.length > 0 ? campaigns.reduce((s, c) => s + c.cost, 0) / campaigns.length : 0;
  const items = campaigns.map(c => {
    const roi = c.roi;
    const cost = c.cost;
    const recentRois = history.filter(h => h.campaign_id === c.campaign_id).map(h => h.roi);
    const consecutiveLowRoi = recentRois.length >= 3 && recentRois.slice(-3).every(r => r < 1);

    if (roi < 1 && consecutiveLowRoi) {
      return { campaign_id: c.campaign_id, action_type: 'pause', suggested_value: null, reason: `ROI=${roi}，连续3天低于1，花费${cost}元，建议关停`, confidence: 0.85 };
    } else if (roi < 1.5 && cost > avgCost) {
      const newCpc = Math.round(c.cpc * 0.8 * 100) / 100;
      return { campaign_id: c.campaign_id, action_type: 'adjust_price', suggested_value: newCpc, reason: `ROI=${roi}偏低且花费高于均值，建议降价20%至CPC=${newCpc}`, confidence: 0.7 };
    } else if (roi > 3 && c.impressions < 5000) {
      return { campaign_id: c.campaign_id, action_type: 'add_budget', suggested_value: Math.round(cost * 1.2 * 100) / 100, reason: `ROI=${roi}优秀但展现量仅${c.impressions}，建议加预算20%`, confidence: 0.75 };
    }
    return { campaign_id: c.campaign_id, action_type: 'no_change', suggested_value: null, reason: `ROI=${roi}，表现正常，维持现状`, confidence: 0.5 };
  });

  const totalCost = campaigns.reduce((s, c) => s + c.cost, 0);
  const totalPay = campaigns.reduce((s, c) => s + c.pay_amount, 0);
  const overallRoi = totalCost > 0 ? Math.round((totalPay / totalCost) * 100) / 100 : 0;

  return {
    shop_summary: `${shop.shop_name}当日总花费${Math.round(totalCost)}元，总成交${Math.round(totalPay)}元，整体ROI=${overallRoi}。`,
    items
  };
}

module.exports = { generateSuggestions, validateSuggestionOutput, SUGGEST_PROMPT_VERSION, minConfidence, SYSTEM_PROMPT };
