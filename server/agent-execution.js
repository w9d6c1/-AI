const { repos } = require('./repositories');
const { requireTenant } = require('./repositories/tenant-context');
const { enforceAiQuota, enforceUsageQuota } = require('./quota');
const { runAgent } = require('./inference');
const { getAgentCatalog } = require('./agent-prompts');
const { validateRequest } = require('./agent-workbench');
const { imageGen, imageEnabled, sizeForRatio, localUploadToDataUri } = require('./ai');
const { ownedFile, registerFile, signFile } = require('./files');
const { httpError } = require('./access');

// 同租户串行检查与执行，避免新工作台并发请求重复消耗剩余额度。
const running = new Set();
async function executeAgent(user, id, body) {
  const tenant = requireTenant();
  if (!getAgentCatalog()[id]) throw httpError(404, '智能体不存在');
  const request = validateRequest(id, body);
  let refImage;
  if (request.options.referenceImage) {
    const url = await ownedFile(user, request.options.referenceImage);
    if (!/\.(png|jpe?g|webp)$/i.test(url)) throw httpError(400, '参考图仅支持 PNG、JPEG、WebP');
    request.options.referenceImage = url;
    refImage = localUploadToDataUri(url);
    if (!refImage) throw httpError(400, '参考图不可读取，请重新上传');
    if (refImage.length > 12 * 1024 * 1024) throw httpError(400, '参考图过大，请压缩到 8MB 以内');
  }
  const render = id === 'a9' && request.options.renderMode === '生成图片';
  if (render && !imageEnabled()) throw httpError(503, '图片模型尚未配置，可先选择「仅生成方案」');
  if (running.has(tenant)) throw httpError(409, '当前团队有智能体正在生成，请稍后重试');
  running.add(tenant);
  try {
    await enforceUsageQuota(tenant);
    await enforceAiQuota(tenant);
    const result = await runAgent(id, request.input, { userId: user.id, extra: request.extra, params: request.options });
    if (render) {
      const plans = result.result.plans || [];
      const images = [];
      const n = request.options.count;
      for (let i = 0; i < n; i++) {
        await enforceUsageQuota(tenant);
        const plan = plans[i] || plans[0];
        const prompt = typeof plan?.prompt === 'string' && plan.prompt.trim() ? plan.prompt : (request.options.imagePrompt || `${request.input}，${request.options.sellingPoints || ''}，${request.options.visualStyle || '商品摄影'}`);
        const img = await imageGen(prompt, { n: 1, size: sizeForRatio(request.options.ratio), image: refImage });
        for (const url of img.urls) {
          await registerFile(user, url);
          await repos.adapter.run('INSERT INTO images (tenant_id,user_id,prompt,style,ratio,url) VALUES (?,?,?,?,?,?)', [tenant, user.id, prompt.slice(0, 500), request.options.visualStyle || '', request.options.ratio, url]);
          images.push({ url, title: plan?.title || `主图 ${i + 1}`, prompt, provider: img.provider || null });
        }
      }
      result.result.images = images;
      result.result.image_status = images.length === n ? 'complete' : images.length ? 'partial' : 'failed';
      if (images.length < n) result.result.warnings.push(`请求 ${n} 张图片，成功 ${images.length} 张；可重试失败部分。`);
    }
    const info = await repos.adapter.run(
      'INSERT INTO agent_runs (user_id,agent_id,agent_name,input,result,result_parsed,source,tokens_est,duration_ms,extra,tenant_id,provider,model,tokens_in,tokens_out,cost,input_options) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [user.id, id, result.agent_name, request.input, result.raw_output, JSON.stringify(result.result), result.source, result.tokens_est, result.duration_ms, request.extra, tenant, result.provider, result.model, result.tokens_in, result.tokens_out, result.cost, JSON.stringify(request.options)]
    );
    return { ...result, runId: info.lastInsertRowid, favorite: 0, options: request.options, extra: request.extra, result: await signResult(user, result.result) };
  } finally { running.delete(tenant); }
}

async function signResult(user, result) {
  if (!result || !Array.isArray(result.images)) return result;
  return { ...result, images: await Promise.all(result.images.map(async img => {
    try { return { ...img, url: await signFile(user, img.url) }; }
    catch { return { ...img, url: '', error: '图片不可访问，请重新生成' }; }
  })) };
}
function parseJson(text, defaultValue) { try { return JSON.parse(text); } catch { return defaultValue; } }
async function readRun(user, id) {
  const run = await repos.adapter.get('SELECT * FROM agent_runs WHERE id=? AND user_id=? AND tenant_id=?', [id, user.id, requireTenant()]);
  if (!run) throw httpError(404, '记录不存在');
  const options = parseJson(run.input_options || '{}', {});
  if (options.referenceImage) {
    try { options.referenceImage = await signFile(user, options.referenceImage); } catch { options.referenceImage = ''; }
  }
  return { ...run, options, result_parsed: await signResult(user, parseJson(run.result_parsed, null)) };
}

module.exports = { executeAgent, readRun, signResult };
