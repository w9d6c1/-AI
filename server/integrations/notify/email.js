// ===== 邮件通知适配器（SMTP）=====
// 契约：{ id, send(channel, context) -> true }
// 依赖环境变量 SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM；未配置则明确报错。
const { sendMail, configFromEnv } = require('./smtp');

async function send(channel, context) {
  if (!channel.email_to) throw new Error('未配置收件邮箱');
  const cfg = configFromEnv();
  if (!cfg.host || !cfg.from) throw new Error('未配置 SMTP（SMTP_HOST/SMTP_FROM）');
  await sendMail({
    ...cfg,
    to: channel.email_to,
    subject: context.title,
    text: context.text
  });
  return true;
}

module.exports = { id: 'email', send };
