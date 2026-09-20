// ===== 租户上下文（AsyncLocalStorage）=====
// 请求级租户隔离的真相源：authRequired 用 runWithTenant 包裹请求；
// 平台级/超管操作用 runAsPlatform 显式放行（审计要求由调用方保证）。
const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

class TenantContextError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TenantContextError';
    this.code = 'TENANT_CONTEXT_MISSING';
    this.status = 500;
  }
}

class TenantScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TenantScopeError';
    this.code = 'TENANT_SCOPE_MISSING';
    this.status = 500;
  }
}

function runWithTenant(tenantId, fn) {
  const id = Number(tenantId);
  if (!Number.isInteger(id) || id <= 0) throw new TenantContextError(`非法 tenantId: ${tenantId}`);
  return storage.run({ tenantId: id, platform: false, impersonatedBy: null }, fn);
}

function runAsPlatform(fn, meta = {}) {
  return storage.run({ tenantId: null, platform: true, impersonatedBy: meta.impersonatedBy ?? null }, fn);
}

function currentTenant() {
  const ctx = storage.getStore();
  return ctx && ctx.tenantId != null ? ctx.tenantId : null;
}

function isPlatform() {
  const ctx = storage.getStore();
  return !!(ctx && ctx.platform);
}

function currentImpersonator() {
  const ctx = storage.getStore();
  return ctx ? ctx.impersonatedBy : null;
}

// 取当前租户；缺失即抛错（fail-closed）
function requireTenant() {
  const id = currentTenant();
  if (id == null) throw new TenantContextError('缺少租户上下文：请在 runWithTenant 内执行，或对平台级操作使用 runAsPlatform');
  return id;
}

module.exports = {
  TenantContextError,
  TenantScopeError,
  runWithTenant,
  runAsPlatform,
  currentTenant,
  isPlatform,
  currentImpersonator,
  requireTenant
};
