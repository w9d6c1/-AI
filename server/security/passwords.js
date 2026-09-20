// ===== 密码策略 / 历史 =====
const bcrypt = require('bcryptjs');

const COMMON = new Set([
  'password', 'password1', '12345678', '123456789', '1234567890', 'qwerty123',
  'admin123', 'admin12345', '11111111', 'abcd1234', 'letmein123', 'welcome123',
  'iloveyou', '88888888', 'password123'
]);

function minLength() { return Number(process.env.PASSWORD_MIN_LENGTH) || 12; }
function historySize() { return Number(process.env.PASSWORD_HISTORY) || 5; }

function validate(password, { username } = {}) {
  const pwd = String(password == null ? '' : password);
  const errors = [];
  if (pwd.length < minLength()) errors.push(`密码长度至少 ${minLength()} 位`);
  if (pwd.length > 128) errors.push('密码不能超过 128 位');
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(re => re.test(pwd)).length;
  if (classes < 3) errors.push('密码需包含小写字母/大写字母/数字/符号中的至少 3 类');
  if (username && pwd.toLowerCase().includes(String(username).toLowerCase())) errors.push('密码不能包含用户名');
  if (COMMON.has(pwd.toLowerCase())) errors.push('密码过于常见，请更换');
  return { ok: errors.length === 0, errors };
}

function hash(password) { return bcrypt.hashSync(String(password), 10); }

function verify(password, hashStr) {
  try { return bcrypt.compareSync(String(password), hashStr); } catch (_) { return false; }
}

function parseHistory(json) {
  try { const a = JSON.parse(json || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; }
}

// 是否复用历史密码（用明文对历史哈希逐一比对）
function reused(password, historyJson) {
  return parseHistory(historyJson).some(h => verify(password, h));
}

// 变更时把旧哈希压入历史，保留最近 N 条
function pushHistory(historyJson, oldHash) {
  const history = parseHistory(historyJson);
  if (oldHash) history.unshift(oldHash);
  return JSON.stringify(history.slice(0, historySize()));
}

module.exports = { validate, hash, verify, reused, pushHistory, parseHistory, minLength, historySize };
