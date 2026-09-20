// ===== AI 服务层（推理层基础设施） =====
// 多 Provider 优先级与故障转移由 integrations/registry 负责：
//   AI_PROVIDERS(JSON) 配置多个源（chat/image 能力、priority、apiKeyEnv）；
//   未配置时回退单源 AI_API_KEY / AI_BASE_URL / AI_MODEL 与 AI_IMAGE_*。
// 未配置对话 Key 时降级规则引擎；未配置生图 Key 时返回占位。
//
// 说明：生图统一以 b64_json 获取并经 storage 落地（local/s3），
// 因为部分厂商（如火山方舟 Seedream）返回的 URL 为 24 小时签名链接，不能长期存储。

const path = require('path');
const fs = require('fs');
const registry = require('./integrations/registry');
const storage = require('./integrations/storage');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');

// 对外导出的模型名（实际调用与故障转移由 ProviderRegistry 决定）
const MODEL = process.env.AI_MODEL || 'doubao-pro-32k';
const IMAGE_MODEL = process.env.AI_IMAGE_MODEL || 'doubao-seedream-3-0-t2i';
const IMAGE_WATERMARK = process.env.AI_IMAGE_WATERMARK === 'true';
const IMAGE_MAX_CONCURRENCY = Math.max(1, parseInt(process.env.AI_IMAGE_MAX_CONCURRENCY || '3', 10));

// 比例 → 合法尺寸（火山方舟 Seedream 4.5 要求 ≥ 3,686,400 像素）
const RATIO_SIZE = {
  '1:1': '2048x2048',
  '3:4': '1728x2304',
  '4:3': '2304x1728',
  '16:9': '2560x1440'
};
function sizeForRatio(ratio) {
  return RATIO_SIZE[ratio] || '2048x2048';
}

function aiEnabled() {
  return registry.hasCapability('chat');
}
function imageEnabled() {
  return registry.hasCapability('image');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ========== LLM 调用（重试/故障转移由 ProviderRegistry 负责） ==========
async function fetchLLM(messages, opts = {}) {
  if (!aiEnabled()) throw new Error('AI_API_KEY 未配置');
  const r = await registry.callChat(messages, opts);
  return r.content;
}

// 返回完整元信息（provider/model/tokens/cost），供用量成本统计
async function fetchLLMDetailed(messages, opts = {}) {
  if (!aiEnabled()) throw new Error('AI_API_KEY 未配置');
  return registry.callChat(messages, opts);
}

// ========== 统计与配置信息 ==========
function getStats() {
  const u = registry.getUsageStats();
  return {
    total_calls: u.total,
    total_tokens_in: u.tokens_in,
    total_tokens_out: u.tokens_out,
    total_cost: u.cost,
    by_provider: u.by_provider
  };
}

function getProviderInfo() {
  const provs = registry.describe();
  const chat = provs.filter(p => p.caps.includes('chat'));
  const image = provs.filter(p => p.caps.includes('image'));
  const primaryChat = chat[0] || {};
  const primaryImage = image[0] || {};
  return {
    chat: {
      provider: primaryChat.id || '未配置',
      model: primaryChat.chat_model || '无',
      enabled: registry.hasCapability('chat'),
      providers: chat
    },
    image: {
      provider: primaryImage.id || '未配置',
      model: primaryImage.image_model || '无',
      watermark: IMAGE_WATERMARK,
      max_concurrency: IMAGE_MAX_CONCURRENCY,
      enabled: registry.hasCapability('image'),
      providers: image
    },
    providers: provs,
    // 兼容旧字段
    provider: primaryChat.id || '未配置',
    model: primaryChat.chat_model || '无',
    image_model: primaryImage.image_model || '无',
    ai_enabled: registry.hasCapability('chat')
  };
}

// ========== 图片持久化 ==========
async function _writeImage(buf) {
  const name = `gen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
  const key = `generated/${name}`;
  await storage.put(key, buf, 'image/jpeg');
  return `/uploads/${key}`;
}

// 将模型返回的 b64 或 URL 落地为本地文件，返回本地访问路径
async function persistImageValue(val) {
  if (!val) return '';
  if (/^https?:\/\//.test(val)) {
    const r = await fetch(val);
    if (!r.ok) return '';
    const buf = Buffer.from(await r.arrayBuffer());
    return _writeImage(buf);
  }
  return _writeImage(Buffer.from(val, 'base64'));
}

// 本地上传文件 → data URI（供图生图作为参考图传给模型）
function localUploadToDataUri(urlPath) {
  if (!urlPath) return null;
  if (urlPath.startsWith('data:')) return urlPath; // 已是 data URI
  if (!urlPath.startsWith('/uploads/')) return null;
  const rel = urlPath.replace(/^\/uploads\//, '');
  const abs = path.resolve(UPLOAD_DIR, rel);
  const relative = path.relative(UPLOAD_DIR, abs);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  if (!fs.existsSync(abs)) return null;
  const ext = path.extname(abs).toLowerCase().replace('.', '');
  const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' }[ext] || 'image/jpeg';
  const b64 = fs.readFileSync(abs).toString('base64');
  return `data:${mime};base64,${b64}`;
}

// 生成 N 张（并发生成 N 次单图，严格按 size 控制比例）
async function imageGen(prompt, opts = {}) {
  const n = Math.min(6, Math.max(1, Number(opts.n) || 1));
  const size = opts.size || '2048x2048';
  const refImage = opts.image || null;

  if (!imageEnabled()) return { urls: [], source: 'placeholder' };

  const results = new Array(n).fill('');
  const errors = [];
  let cursor = 0;
  let usedProvider = null;

  async function worker() {
    while (cursor < n) {
      const i = cursor++;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await registry.callImage(prompt, { size, image: refImage });
          usedProvider = r.provider || usedProvider;
          const local = await persistImageValue(r.values[0]);
          if (local) { results[i] = local; break; }
        } catch (e) {
          if (attempt === 1) errors.push(e.message);
          else await sleep(800);
        }
      }
    }
  }

  const workers = Array.from({ length: Math.min(IMAGE_MAX_CONCURRENCY, n) }, () => worker());
  await Promise.all(workers);

  const urls = results.filter(Boolean);
  if (errors.length) console.warn('[AI] 部分图片生成失败:', errors.join(' | '));
  return { urls, source: urls.length ? 'llm' : 'placeholder', errors, provider: usedProvider };
}

// 兼容旧接口：单张生成
async function fetchImage(prompt, opts = {}) {
  const { urls } = await imageGen(prompt, { ...opts, n: 1 });
  return urls;
}

// ===== 内置电商规则引擎（降级方案） =====
function ruleReply(text, history = []) {
  const t = (text || '').toLowerCase();
  if (t.includes('点击率') || t.includes('ctr') || t.includes('主图')) {
    return '根据你的店铺数据分析，我检测到以下情况：\n\n1. 本周主图 CTR 为 2.14%，较上周下降 1.8pp\n2. 主要竞品更新了强对比场景图，其 CTR 达到 3.92%\n3. 你的白底图在搜索结果页中的视觉冲击力不足\n\n优化建议：\n- 使用「主图策划」智能体生成 3 套场景方案进行 AB 测试\n- 增加产品使用场景展示，突出核心卖点\n- 优化文案层级，标题字号不小于图片宽度的 1/8\n\n需要我帮你生成具体的主图优化方案吗？';
  }
  if (t.includes('roi') || t.includes('投产') || t.includes('推广')) {
    return '以下是你各渠道的 ROI 分析：\n\n- 直通车：ROI 3.8，花费占比 45%，主要亏损词为「无线耳机 通用」（出价过高）\n- 超级推荐：ROI 5.2，表现最优，建议增加预算 20%\n- 万相台：ROI 2.9，新计划处于学习期，建议观察 3-5 天\n\n优化方案：\n1. 降低直通车泛词出价 15%，精准词加价 10%\n2. 超级推荐预算从 500/天 提升至 600/天\n3. 万相台暂停低效计划，集中预算到高转化人群';
  }
  if (t.includes('选品') || t.includes('蓝海') || t.includes('选款')) {
    return '基于近30天市场数据，为你挖掘到以下蓝海机会：\n\n- 「降噪睡眠耳机」：搜索量月增 34%，在线商品数仅 1,200，竞争度低\n- 「骨传导运动耳机」：转化率 4.8% 高于类目均值，客单价 200-300 元区间空白\n- 「电竞低延迟耳机」：抖音渠道增速最快，达 156%，适合内容驱动\n\n建议优先关注「降噪睡眠耳机」赛道，目前进入窗口期约 2-3 个月。需要我做更深入的竞品分析吗？';
  }
  if (t.includes('竞品') || t.includes('对比')) {
    return '竞品分析摘要（以你关注的类目为例）：\n\n1. 头部 5 款商品占据 42% 销量，市场集中度中等偏高\n2. 竞品平均客单价 ¥168，主流价格带 150-220 元\n3. 头部竞品主图普遍采用「场景图+卖点标注」组合，CTR 平均 3.8%\n4. 评价关键词集中在「品质」「性价比」「售后」\n\n差异化建议：在「续航/舒适度」等被忽视维度建立优势，定价比头部低 10%，配合首单立减。';
  }
  if (t.includes('利润') || t.includes('毛利') || t.includes('成本')) {
    return '利润测算结果（示例数据）：\n\n- 商品售价：¥199\n- 成本合计：¥138（货品 ¥85 + 物流 ¥12 + 推广 ¥28 + 平台扣点 ¥13）\n- 单件毛利：¥61（毛利率 30.7%）\n- 月销 1,000 件的预期月利润：¥61,000\n\n优化空间：\n1. 推广费用占比 14% 偏高，优化后可提升至 10%（毛利 +8 元/件）\n2. 物流成本可通过换仓/谈价降低 2-3 元/件\n3. 建议组合销售提升客单价，摊薄固定成本';
  }
  if (t.includes('评价') || t.includes('差评') || t.includes('口碑')) {
    return '评价分析结果：\n\n好评关键词 TOP3：质量好（32%）、物流快（24%）、性价比高（19%）\n差评关键词 TOP3：尺码偏小（28%）、掉色（17%）、客服响应慢（12%）\n\n改进建议：\n1. 尺码问题 → 详情页增加尺码对照表 + 直播实测展示\n2. 掉色问题 → 更换供应商面料检测报告，详情页展示质检证书\n3. 客服响应 → 设置快捷回复模板，响应时间目标 < 30 秒';
  }
  return '收到你的问题。作为电商 AI 顾问，我可以帮你处理以下类型的分析：\n\n1. 经营数据分析 —— 上传店铺数据表格，我来做深度诊断\n2. 选品调研 —— 蓝海词挖掘、竞品透视、市场趋势判断\n3. 推广优化 —— ROI 拆解、亏损词诊断、预算分配建议\n4. 视觉营销 —— 主图/详情页诊断、内容生成建议\n5. 财税合规 —— 税务风险自查、利润核算\n\n你可以更具体地描述你的需求，或者直接上传数据文件，我来帮你分析。';
}

// 智能体分析引擎（降级时使用模板生成结构化报告，保留兼容）
function agentTemplate(agentId, agentName, input) {
  const k = (input || '示例商品');
  return {
    overview: `针对「${k}」的${agentName}分析已完成。分析周期：近30天，共处理数据 2,847 条。`,
    findings: [
      '市场竞争度中等偏上，头部 5 款商品占据 42% 销量',
      '用户核心关注点集中在「品质」「性价比」「售后服务」三个维度',
      '近30天搜索量环比增长 18.5%，处于上升通道',
      '竞品平均客单价 ¥168，你的商品定价处于中位水平'
    ],
    suggestions: [
      '标题优化：增加「2024新款」「官方正品」等高转化词，预计流量提升 15%',
      '主图升级：当前主图 CTR 2.1%，建议增加场景化展示，目标 CTR 提升至 3.5%',
      '详情页重构：前 3 屏强化核心卖点与信任背书，降低跳失率',
      '推广策略：直通车精准词加价 10%，泛词降价 15%，预计 ROI 提升 0.8'
    ],
    expected: '按上述方案执行后，预计 30 天内：访客数 +22%，转化率 +0.8pp，月销售额提升 ¥45,000+。'
  };
}

// 对话：优先真实 LLM，失败/未配置时降级规则引擎；opts.knowledge 为知识库检索片段（RAG）
async function chatReply(text, history = [], opts = {}) {
  if (aiEnabled()) {
    try {
      let sys = '你是「智营AI」电商经营顾问，服务于电商企业经营者。请基于电商运营方法论给出专业、结构化、可执行的建议。回答使用中文，尽量使用要点列表，涉及数据时给出具体数字。';
      if (opts.knowledge) {
        sys += `\n\n【知识库参考】\n${opts.knowledge}\n\n请优先依据以上知识库内容回答；若与知识库无关，再按通用电商方法论回答。`;
      }
      const messages = [{ role: 'system', content: sys }];
      const recent = history.slice(-6);
      recent.forEach(m => messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));
      if (text) messages.push({ role: 'user', content: text });
      const reply = await fetchLLM(messages);
      if (reply) return { content: reply, source: 'llm' };
    } catch (e) {
      console.warn('[AI] LLM 调用失败，降级规则引擎:', e.message);
    }
  }
  return { content: ruleReply(text, history), source: 'rule' };
}

// 智能体执行（旧接口，兼容 routes/agents.js，新代码应使用 inference.runAgent）
async function agentRun(agentId, agentName, input, extra = '') {
  if (aiEnabled()) {
    try {
      const sys = `你是「智营AI」平台的「${agentName}」。请基于电商运营方法论，对用户输入进行分析并输出结构化报告。要求包含：分析概览、核心发现（要点列表）、优化建议（编号列表）、预期效果。使用中文。`;
      const reply = await fetchLLM([
        { role: 'system', content: sys },
        { role: 'user', content: `分析对象：${input}${extra ? '\n补充说明：' + extra : ''}` }
      ]);
      if (reply) return { content: reply, source: 'llm' };
    } catch (e) {
      console.warn('[AI] 智能体调用失败，降级模板:', e.message);
    }
  }
  const t = agentTemplate(agentId, agentName, input);
  return { content: t, source: 'template' };
}

module.exports = {
  chatReply, imageGen, agentRun, aiEnabled, imageEnabled,
  fetchLLM, fetchLLMDetailed, fetchImage, sizeForRatio,
  getStats, getProviderInfo,
  localUploadToDataUri, persistImageValue,
  MODEL, IMAGE_MODEL
};
