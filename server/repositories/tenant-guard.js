// ===== 租户隔离守卫 =====
// adapter 层 fail-closed：任何命中租户表的 SQL 必须（1）处于租户上下文；（2）显式包含 tenant_id。
// 平台级操作（迁移、种子、超管、登录查找）通过 runAsPlatform 显式放行。
const { isPlatform, currentTenant, TenantContextError, TenantScopeError } = require('./tenant-context');

// 带 tenant_id 的表（与迁移 0003 的 TENANT_TABLES 保持一致）
const TENANT_TABLES = new Set([
  'teams', 'users', 'chats', 'messages', 'agent_runs', 'canvas_boards', 'canvas_elements',
  'competitor_reports', 'tasks', 'task_logs', 'course_progress', 'images', 'kb_docs',
  'shop_groups', 'shops', 'user_shop_permissions', 'daily_reports', 'ad_campaigns',
  'suggestions', 'suggestion_items', 'executions', 'collection_tasks', 'audit_logs',
  'collection_schedules', 'schedule_runs', 'alert_rules', 'alerts', 'notification_channels',
  'notifications', 'batch_operations', 'batch_items', 'report_templates', 'report_records',
  'file_assets', 'import_batches', 'products', 'product_daily', 'orders_daily', 'refunds_daily',
  'kb_chunks', 'ai_usage', 'invoices', 'invoice_items', 'payments'
]);

// 匹配 from/join/into/update 后的表名，以及紧随其后的逗号连接表（FROM a, b）
const TABLE_REF = /\b(?:from|join|into|update)\s+("?[a-zA-Z_][a-zA-Z0-9_]*"?)((?:\s*,\s*"?[a-zA-Z_][a-zA-Z0-9_]*"?)*)/gi;

function referencedTables(sql) {
  const set = new Set();
  TABLE_REF.lastIndex = 0;
  let m;
  while ((m = TABLE_REF.exec(sql))) {
    set.add(m[1].replace(/"/g, '').toLowerCase());
    if (m[2]) {
      for (const part of m[2].split(',')) {
        const name = part.trim().replace(/"/g, '').toLowerCase();
        if (name) set.add(name);
      }
    }
  }
  return set;
}

function assertTenantScoped(sql) {
  if (isPlatform()) return;
  const tables = referencedTables(sql);
  let scoped = false;
  for (const t of tables) {
    if (TENANT_TABLES.has(t)) { scoped = true; break; }
  }
  if (!scoped) return;
  if (currentTenant() == null) {
    throw new TenantContextError(`租户表访问缺少上下文: ${[...tables].filter(t => TENANT_TABLES.has(t)).join(', ')}`);
  }
  if (!/\btenant_id\b/i.test(sql)) {
    throw new TenantScopeError(`租户表查询缺少 tenant_id 过滤: ${sql.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
  }
}

module.exports = { TENANT_TABLES, referencedTables, assertTenantScoped };
