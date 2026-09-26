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
  } else {
    base.opportunities = words.map(keyword => ({ keyword, evidence: '用户输入的待研究方向', competition: null, opportunity_score: null, audience: o.audience || '待验证', price_range: o.priceRange || '待验证', action: '补充搜索趋势、商品数与价格分布后评估', risk: '目前不能判断是否为蓝海' }));
    base.missing_data = ['真实搜索量及增长率', '竞争商品数与成交分布'];
  }
  return base;
}

module.exports = { fallback };
