// ===== 登录锁定 =====
const { repos } = require('../repositories');
const { runAsPlatform } = require('../repositories/tenant-context');
const { nowLocal } = require('../util');

function maxAttempts() { return Number(process.env.LOGIN_MAX_ATTEMPTS) || 5; }
function lockMinutes() { return Number(process.env.LOGIN_LOCK_MINUTES) || 15; }

function isLocked(user) {
  if (!user || !user.locked_until) return false;
  return String(user.locked_until) > nowLocal();
}

// 失败一次：达阈值则锁定。返回 { count, locked, locked_until }
async function registerFailure(user) {
  const count = (user.failed_login_count || 0) + 1;
  const locked = count >= maxAttempts();
  const lockedUntil = locked ? nowLocal(new Date(Date.now() + lockMinutes() * 60000)) : null;
  await runAsPlatform(() => repos.users.update(user.id, {
    failed_login_count: locked ? 0 : count,
    locked_until: lockedUntil
  }, { platform: true }));
  return { count, locked, locked_until: lockedUntil };
}

async function reset(userId) {
  await runAsPlatform(() => repos.users.update(userId, { failed_login_count: 0, locked_until: null }, { platform: true }));
}

module.exports = { maxAttempts, lockMinutes, isLocked, registerFailure, reset };
