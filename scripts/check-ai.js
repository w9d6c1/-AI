// ===== AI Provider 连通性自检（密钥轮换后执行）=====
// 用法：node scripts/check-ai.js [--image]
// 退出码：0=可用；1=有 provider 调用失败。
require('dotenv').config();
const registry = require('../server/integrations/registry');

(async () => {
  const providers = registry.describe();
  console.log('[check-ai] 已配置 provider：');
  for (const p of providers) console.log(`  - ${p.id} priority=${p.priority} caps=${p.caps.join(',')} chat_key=${p.has_chat_key} image_key=${p.has_image_key}`);

  let failed = false;

  if (!registry.hasCapability('chat')) {
    console.error('[check-ai] 无可用对话 provider（检查 AI_PROVIDERS 或 AI_API_KEY）');
    failed = true;
  } else {
    const t = Date.now();
    try {
      const r = await registry.callChat([{ role: 'user', content: '只回复 ok' }], { maxTokens: 16, temperature: 0 });
      console.log(`[check-ai] 对话 OK：provider=${r.provider} model=${r.model} ${Date.now() - t}ms`);
    } catch (e) {
      failed = true;
      console.error('[check-ai] 对话失败:', e.message);
    }
  }

  if (process.argv.includes('--image')) {
    if (!registry.hasCapability('image')) {
      console.error('[check-ai] 无可用生图 provider（检查 AI_IMAGE_API_KEY / AI_PROVIDERS）');
      failed = true;
    } else {
      const t = Date.now();
      try {
        // Seedream 4.5 要求尺寸 ≥ 3,686,400 像素，用 2048x2048
        const r = await registry.callImage('一只白色陶瓷杯，纯色背景', { size: '2048x2048' });
        console.log(`[check-ai] 生图 OK：provider=${r.provider} 张数=${r.values.length} ${Date.now() - t}ms`);
      } catch (e) {
        failed = true;
        console.error('[check-ai] 生图失败:', e.message);
      }
    }
  }

  // 不用 process.exit：避免 Windows 下 undici 连接被强制关闭触发 libuv 断言
  process.exitCode = failed ? 1 : 0;
})().catch((e) => {
  console.error('[check-ai] 异常:', e.message);
  process.exitCode = 1;
});
