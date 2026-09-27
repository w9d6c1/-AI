const { parseCsv } = require('./csv');
const { definitions } = require('./agent-workbench');

// 离线结果仅使用用户输入；分析框架不冒充真实市场分析。
function fallback(id, input, o = {}) {
  const c = definitions[id];
  if (!c) return null;
  const base = { overview: `「${input}」的${c.label}参考结果`, data_source: 'template', warnings: ['当前为本地规则 / 模板结果，未使用大模型。'], missing_data: [], evidence: [], suggestions: [] };
  const count = o.count || 3;
  const points = String(o.sellingPoints || '').split(/[\n；;]/).map(s => s.trim()).filter(Boolean);
  const words = [...new Set([input, ...String(o.keywords || '').split(/[，,\n]/).map(s => s.trim()).filter(Boolean)])];
  const clip = (s, n) => Array.from(s).slice(0, n || 2000).join('');
  const scene = o.scene || '日常使用';
  if (id === 'a7') {
    base.titles = Array.from({ length: count }, (_, i) => {
      const terms = [...words.slice(i % words.length), ...words.slice(0, i % words.length)];
      const angle = [points[i % (points.length || 1)], o.audience, scene].filter(Boolean);
      const title = clip([...terms, ...angle].join(' '), o.maxLength || 30);
      return { title, angle: ['关键词优先', '卖点优先', '场景优先'][i % 3], rationale: '按已提供词语组合，未预测搜索排名或转化率' };
    });
    if (!points.length) base.missing_data.push('商品核心卖点');
    base.suggestions = ['结合商品真实属性筛选标题，再进行点击与转化对照测试。'];
  } else if (id === 'a17') {
    const benefit = points.length ? points.join('；') : '【请补充真实商品卖点】';
    const templates = {
      '商品五点描述': () => Array.from({ length: 5 }, (_, i) => `${i + 1}. ${points[i] || '【请补充第' + (i + 1) + '项真实特点】'}`).join('\n'),
      '详情页文案': () => `认识${input}\n适用场景：${scene}\n核心特点：${benefit}\n适合人群：${o.audience || '【待确认】'}\n商品参数与服务：请以商品页实际信息为准。`,
      '活动促销': () => `${input}，${benefit}。\n活动信息：${o.offer || '【请填写真实优惠与有效期】'}\n了解活动规则后，选择适合自己的规格。`,
      '短视频脚本': () => `开场（0–3秒）：展示${scene}中的实际需求。\n展示（3–15秒）：${input}特写，演示${benefit}。\n收尾（15–20秒）：说明适用人群与选择方法，引导查看商品参数。`,
      '直播话术': () => `正在关注${input}的朋友，可以先看这几个细节：${benefit}。\n它的使用场景是${scene}。${o.offer ? '本次活动：' + o.offer : '具体价格和服务以商品页为准。'}有规格问题可以在评论区提问。`,
      '客服回复': () => `您好，关于${input}，已确认的特点是：${benefit}。请告诉我们您的使用场景或规格需求，我们会根据实际商品信息进一步为您解答。`,
      '小红书种草': () => `${scene}选购笔记｜${input}\n挑选时可以关注：${benefit}。\n适用人群：${o.audience || '按实际需求选择'}。\n这是商品信息介绍，购买前请核对参数与尺寸。`,
      '新品上市': () => `${input}新品介绍\n${benefit}\n面向${o.audience || '有相关使用需求的用户'}，适用于${scene}。查看商品详情，了解规格与服务。`
    };
    base.copies = Array.from({ length: count }, (_, i) => {
      const opening = ['从需求出发', '把特点说清楚', '为场景选好物', '关注使用细节', '按需选择'][i % 5];
      const body = (templates[o.contentType] || (() => `${input}：${benefit}。\n适用场景：${scene}。${o.offer ? '\n' + o.offer : ''}`))();
      return { title: `${opening} · ${input}`, content: clip(`${opening}\n${body}`, o.maxLength || 300), platform: o.platform || '淘宝', tone: o.style || '专业可信', angle: opening };
    });
    if (o.revision) base.warnings.push('离线模板无法进行语义改写；请配置文字模型后重新生成。');
    if (!points.length) base.missing_data.push('商品卖点与参数');
  } else if (id === 'a8' || id === 'a9') {
    const directions = ['商品主体', '使用场景', '细节特写', '卖点说明', '规格说明', '组合展示'];
    base.plans = Array.from({ length: count }, (_, i) => ({
      title: directions[i % directions.length], objective: '清楚呈现商品与已确认特点',
      composition: i % 2 ? '主体置于场景中心，保留文字留白' : '主体居中，占画面约三分之二，背景简洁',
      palette: o.visualStyle || '中性背景，品牌色作为点缀', copy: points[i % (points.length || 1)] || input,
      scene,
      prompt: `${o.imagePrompt || input}。${directions[i % directions.length]}，${scene}，${o.visualStyle || '自然光、真实商品摄影'}。${points.join('；')}。保留商品原有形状、材质、标识与颜色，不增加未经确认的配件；画面无虚构认证文字。`
    }));
    base.suggestions = ['生成后核对商品外观、文字和参数，再用于商品展示。'];
  } else if (id === 'a4') {
    const reviews = String(o.reviews || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    base.sample_count = reviews.length;
    const terms = ['质量', '尺寸', '尺码', '颜色', '物流', '客服', '包装', '材质', '价格', '保温', '漏水', '舒适', '气味'];
    base.themes = terms.map(keyword => ({ keyword, sentiment: '未进行语义判断', count: reviews.filter(r => r.includes(keyword)).length, evidence: reviews.filter(r => r.includes(keyword)).slice(0, 3), action: '核对原文语境后分类为卖点或改进点' })).filter(x => x.count).sort((a, b) => b.count - a.count);
    base.overview = `已读取 ${reviews.length} 行评价，以下为关键词逐行匹配结果。`;
    base.evidence = reviews.slice(0, 3);
    base.selling_points = []; base.pain_points = [];
    if (!reviews.length) base.missing_data.push('评价原文');
    base.suggestions = ['一行一条评价，重复评价请先去重；关键词计数不等于情绪判断。'];
  } else if (id === 'a6') {
    base.keywords = words.flatMap(w => [
      { keyword: w, intent: '商品搜索', category: '核心词', evidence: '用户输入', volume: null, trend: null, priority: '待数据验证', use: '标题与商品描述' },
      { keyword: `${o.audience || '日常'} ${w}`, intent: '场景 / 人群匹配', category: '拓展词', evidence: '规则组合，非真实搜索数据', volume: null, trend: null, priority: '待数据验证', use: '内容主题测试' }
    ]);
    base.missing_data = ['关键词搜索量、竞争度与周期趋势'];
  } else if (id === 'a2') {
    const rows = parseCsv(o.dataText || '').records;
    base.products = rows.slice(0, 100).map(r => {
      const value = names => names.map(k => r[k]).find(v => v !== undefined && v !== '');
      const name = value(['商品', '商品名称', 'name', 'title']);
      const rawPrice = value(['售价', 'price']), rawCost = value(['总成本', 'total_cost']);
      const price = Number(rawPrice), cost = Number(rawCost);
      const margin = rawPrice !== undefined && rawCost !== undefined && Number.isFinite(price) && Number.isFinite(cost) && price > 0 && cost >= 0 ? (price - cost) / price * 100 : null;
      return { name: name || '未命名商品', classification: margin === null ? '待补数据' : margin < 0 ? '负毛利风险' : '毛利候选', profit_rate: margin === null ? null : Math.round(margin * 100) / 100, evidence: margin === null ? '缺少可计算的售价或总成本' : `用户数据：售价${price}，总成本${cost}；毛利率=(售价−总成本)/售价`, action: '结合销量、退货和推广费用复核' };
    }).sort((a, b) => (b.profit_rate ?? -Infinity) - (a.profit_rate ?? -Infinity));
    if (!rows.length) base.missing_data = ['CSV 商品明细，建议表头：商品名称,售价,总成本'];
    base.suggestions = ['总成本需包含货品、平台、履约和推广等支出；计算结果不等于净利润。'];
  } else if (id === 'a3') {
    base.health_score = null;
    base.issues = ['曝光', '点击', '转化', '售后'].map(dimension => ({ dimension, issue: '待数据诊断', evidence: '本地框架未判断该指标是否异常', severity: '待确认', action: { 曝光: '核对曝光量与流量来源', 点击: '核对展现、点击与主图版本', 转化: '核对访客、支付买家与价格', 售后: '核对退款数量、原因及评价' }[dimension], validation: '补充同周期实际数据后复核' }));
    base.missing_data = ['商品粒度的经营漏斗数据及对比基准'];
  } else if (id === 'a5') {
    const rows = String(o.questions || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const groups = ['产品功能', '价格与性价比', '使用场景', '售后服务', '对比选择'];
    base.question_categories = groups.map((category, i) => ({ category, count: rows.length ? Math.ceil(rows.length / groups.length) : 0, percentage: rows.length ? Math.round(100 / groups.length) : 0, evidence: rows.slice(i, i + 2) }));
    base.top_concerns = rows.slice(0, 5);
    base.detail_page_suggestions = rows.slice(0, 5).map(question => ({ question, content_suggestion: '在详情页补充基于真实参数和服务政策的明确回答', placement: '功能 / 售后说明区域' }));
    if (!rows.length) base.missing_data.push('问大家原文');
  } else if (id === 'a10') {
    const themes = ['核心卖点', '用户痛点', '使用场景', '细节与参数', '信任依据', '对比优势', '行动提示'];
    base.logic_flow = '从真实需求切入，依次说明商品特点、使用方式、可信依据和购买前需确认的信息。';
    base.screens = themes.slice(0, count).map((theme, i) => ({ screen: i + 1, theme, content: points[i] || '待补充真实内容', visual_direction: o.visualStyle || '清晰、克制、突出商品主体', key_message: `第${i + 1}屏重点说明${theme}` }));
    if (!points.length) base.missing_data.push('商品核心卖点');
  } else if (id === 'a11') {
    base.style = o.style || '专业可信';
    base.sections = Array.from({ length: count }, (_, i) => ({ screen: i + 1, title: `${input} · 第${i + 1}屏`, body: clip(`围绕${points[i] || '已确认商品特点'}说明使用场景和选择依据；参数、资质、优惠请以真实资料为准。`, o.maxLength || 200), cta: '查看真实参数与服务说明' }));
    if (!points.length) base.missing_data.push('商品卖点与参数');
  } else if (id === 'a12') {
    base.buyer_personas = Array.from({ length: count }, (_, i) => ({ name: `创意用户画像${i + 1}`, profile: o.persona || '待由真实用户资料确认', scene, review_text: `这是围绕${input}的买家秀创意文案，不代表真实用户评价。`, image_prompt_en: `authentic product lifestyle photo of ${input}, ${scene}, no invented claims, no fake testimonial text` }));
    base.warnings.push('买家秀内容必须取得真实用户授权并人工审核，不得冒充真实评价。');
  } else if (id === 'a13') {
    base.channel_analysis = [{ channel: '待识别渠道', cost: null, roi: null, status: '待数据', issue: '请提供推广明细或授权店铺广告数据' }];
    base.loss_campaigns = []; base.efficient_campaigns = []; base.budget_reallocation = [];
    base.missing_data.push('推广计划、花费、成交额和 ROI');
    base.requires_review = true;
  } else if (id === 'a14') {
    base.campaign_status = [{ campaign: '待识别计划', stage: '待数据', roi: null, cost: null, status: '待核验' }];
    base.adjustments = []; base.crowd_strategy = [];
    base.missing_data.push('万相台计划、人群和预算数据');
    base.requires_review = true;
  } else if (id === 'a15') {
    base.channel_breakdown = ['自然搜索', '推荐', '付费', '内容', '私域'].map(channel => ({ channel, visitors: null, percentage: null, conversion_rate: null, health: '待数据' }));
    base.imbalance_issues = ['缺少渠道明细，暂不能判断流量结构是否健康']; base.optimization = [];
    base.missing_data.push('分渠道访客、订单和成交数据');
  } else if (id === 'a16') {
    base.regional_analysis = []; base.high_value_regions = []; base.low_efficiency_regions = []; base.adjustments = [];
    base.missing_data.push('地域访客、订单、成交额、花费和 ROI');
    base.requires_review = true;
  } else if (id === 'a18') {
    base.risk_assessment = { level: '待专业复核', score: null };
    base.risks = [{ type: '数据完整性', description: '当前仅能基于已提供材料检查，不能替代税务专业判断', level: '待确认', regulation: '需核对适用政策版本', action: '补充主体、交易、发票、退款和申报资料后复核' }];
    base.compliance_suggestions = [{ item: '资料留存', current_status: '待确认', suggestion: '建立交易、发票、退款和申报资料的关联留痕', priority: '高' }];
    base.missing_data.push('主体类型、发票、退款和申报信息');
    base.warnings.push('财税结果仅供风险排查，必须由税务专业人员结合最新政策复核。');
  } else if (id === 'a19') {
    base.data_source = 'framework';
    base.base = { category: '待补充', shop: '待补充', monthlySales: '需数据源', price: '待补充', rating: '待补充' };
    base.dimensions = ['搜索排名', '主图吸引力', '评价质量', '价格竞争力', '销量趋势', '促销力度'].map(label => ({ label, value: '需数据源', score: null }));
    base.radar = { competitor: [0, 0, 0, 0, 0, 0], self: [0, 0, 0, 0, 0, 0] };
    base.missing_data.push('竞品公开数据与自有店铺对比数据');
    base.suggestions = ['接入可核验竞品数据后重新运行；当前结果仅为比较框架。'];
  } else {
    base.opportunities = words.map(keyword => ({ keyword, evidence: '用户输入的待研究方向', competition: null, opportunity_score: null, audience: o.audience || '待验证', price_range: o.priceRange || '待验证', action: '补充搜索趋势、商品数与价格分布后评估', risk: '目前不能判断是否为蓝海' }));
    base.missing_data = ['真实搜索量及增长率', '竞争商品数与成交分布'];
  }
  return base;
}

module.exports = { fallback };
