// ===== 数据合规：第三方 LLM 出境前 PII 脱敏 =====
// LLM_REDACT_PII=true 时，发送给第三方模型的文本中的手机号/邮箱/身份证/银行卡将被掩码。
const RULES = [
  { name: 'idcard', re: /(?<!\d)\d{17}[\dXx](?!\d)/g, mask: '******************' },
  { name: 'bankcard', re: /(?<!\d)\d{16,19}(?!\d)/g, mask: '****************' },
  { name: 'phone', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g, mask: '1**********' },
  { name: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, mask: '***@***' }
];

function redactEnabled() { return process.env.LLM_REDACT_PII === 'true'; }

function redact(text) {
  let out = String(text == null ? '' : text);
  for (const r of RULES) out = out.replace(r.re, r.mask);
  return out;
}

function redactMessages(messages) {
  return (messages || []).map(m => ({ ...m, content: redact(m.content) }));
}

module.exports = { redactEnabled, redact, redactMessages, RULES };
