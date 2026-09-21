// ===== 数据库层：SQLite 初始化与 Schema =====
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const dbPath = process.env.DB_PATH || path.join(DATA_DIR, 'ecom-ai.db');
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

// node:sqlite 无 better-sqlite3 的 transaction()，提供兼容实现
db.transaction = (fn) => function (...args) {
  db.exec('BEGIN');
  try {
    const result = fn.apply(this, args);
    db.exec('COMMIT');
    return result;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
};

// ===== Schema =====
db.exec(`
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  status TEXT DEFAULT 'active',
  plan TEXT DEFAULT 'trial',
  max_shops INTEGER DEFAULT 50,
  max_ai_calls_per_month INTEGER DEFAULT 100000,
  max_tokens_per_month INTEGER DEFAULT 0,
  billing_cycle TEXT DEFAULT 'monthly',
  price_per_month REAL DEFAULT 0,
  max_cost_per_month REAL DEFAULT 0,
  tax_rate REAL DEFAULT 0,
  trial_ends_at TEXT,
  contact_name TEXT,
  contact_email TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  owner_id INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  team_id INTEGER,
  role TEXT DEFAULT 'member',
  totp_secret TEXT,
  totp_enabled INTEGER DEFAULT 0,
  totp_recovery TEXT,
  failed_login_count INTEGER DEFAULT 0,
  locked_until TEXT,
  password_changed_at TEXT,
  password_history TEXT,
  must_change_password INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (team_id) REFERENCES teams(id)
);

CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  chat_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  agent_name TEXT,
  input TEXT,
  result TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS canvas_boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER NOT NULL,
  name TEXT DEFAULT '未命名画板',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS canvas_elements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  board_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  x REAL DEFAULT 0,
  y REAL DEFAULT 0,
  text TEXT DEFAULT '',
  color TEXT DEFAULT '#0d9488',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (board_id) REFERENCES canvas_boards(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS competitor_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER NOT NULL,
  target TEXT NOT NULL,
  report TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  icon TEXT DEFAULT '📊',
  color TEXT DEFAULT '#f0fdfa',
  desc TEXT DEFAULT '',
  freq TEXT DEFAULT '每日 09:00',
  enabled INTEGER DEFAULT 1,
  last_run_at TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS task_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  task_id INTEGER,
  user_id INTEGER NOT NULL,
  msg TEXT NOT NULL,
  status TEXT DEFAULT 'info',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  cat TEXT DEFAULT '运营',
  icon TEXT DEFAULT '📚',
  color TEXT DEFAULT 'linear-gradient(135deg,#0d9488,#14b8a6)',
  duration TEXT DEFAULT '6课时',
  level TEXT DEFAULT '入门',
  desc TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS course_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER NOT NULL,
  course_id INTEGER NOT NULL,
  progress INTEGER DEFAULT 0,
  chapters_done INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(user_id, course_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (course_id) REFERENCES courses(id)
);

CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  style TEXT DEFAULT '',
  ratio TEXT DEFAULT '1:1',
  url TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS kb_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  size INTEGER DEFAULT 0,
  status TEXT DEFAULT 'indexed',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- ===== 多店铺管理模块 =====
CREATE TABLE IF NOT EXISTS shop_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL UNIQUE,
  batch_no INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS shops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  shop_name TEXT NOT NULL,
  wangwang_id TEXT,
  qianniu_account TEXT NOT NULL,
  rpa_robot_id TEXT,
  group_id INTEGER,
  platform TEXT DEFAULT 'taobao',
  status TEXT DEFAULT 'active',
  daily_adjust_limit INTEGER DEFAULT 5,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (group_id) REFERENCES shop_groups(id)
);

CREATE TABLE IF NOT EXISTS user_shop_permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER NOT NULL,
  shop_id INTEGER NOT NULL,
  permission_level TEXT DEFAULT 'view',
  UNIQUE(user_id, shop_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS daily_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  shop_id INTEGER NOT NULL,
  report_date TEXT NOT NULL,
  visitors INTEGER,
  payed_buyer_count INTEGER,
  pay_amount REAL,
  pay_item_count INTEGER,
  conversion_rate REAL,
  avg_unit_price REAL,
  raw_json TEXT,
  collected_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(shop_id, report_date),
  FOREIGN KEY (shop_id) REFERENCES shops(id)
);

CREATE TABLE IF NOT EXISTS ad_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  shop_id INTEGER NOT NULL,
  platform TEXT DEFAULT 'taobao',
  account_id TEXT,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT NOT NULL,
  campaign_type TEXT DEFAULT 'standard',
  report_date TEXT NOT NULL,
  cost REAL NOT NULL,
  impressions INTEGER NOT NULL,
  clicks INTEGER NOT NULL,
  ctr REAL,
  cpc REAL,
  pay_amount REAL,
  roi REAL,
  status TEXT DEFAULT 'running',
  raw_json TEXT,
  collected_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(shop_id, campaign_id, report_date),
  FOREIGN KEY (shop_id) REFERENCES shops(id)
);

CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  shop_id INTEGER NOT NULL,
  suggestion_date TEXT NOT NULL,
  ai_summary TEXT,
  status TEXT DEFAULT 'pending',
  prompt_version TEXT,
  model TEXT,
  source TEXT,
  excluded_items INTEGER DEFAULT 0,
  reviewed_by INTEGER,
  reviewed_at TEXT,
  review_comment TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (shop_id) REFERENCES shops(id),
  FOREIGN KEY (reviewed_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS suggestion_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  suggestion_id INTEGER NOT NULL,
  campaign_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  current_value REAL,
  suggested_value REAL,
  reason TEXT,
  confidence REAL DEFAULT 0.5,
  status TEXT DEFAULT 'pending',
  FOREIGN KEY (suggestion_id) REFERENCES suggestions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  suggestion_item_id INTEGER,
  shop_id INTEGER NOT NULL,
  rpa_job_id TEXT,
  action_type TEXT NOT NULL,
  target_campaign_id TEXT NOT NULL,
  params_json TEXT,
  status TEXT DEFAULT 'queued',
  screenshot_url TEXT,
  error_msg TEXT,
  actual_value REAL,
  expected_value REAL,
  before_value REAL,
  is_auto INTEGER DEFAULT 0,
  approved_by INTEGER,
  approved_at TEXT,
  not_before TEXT,
  rollback_of INTEGER,
  reason TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (shop_id) REFERENCES shops(id),
  FOREIGN KEY (suggestion_item_id) REFERENCES suggestion_items(id)
);

CREATE TABLE IF NOT EXISTS collection_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  shop_id INTEGER NOT NULL,
  task_date TEXT NOT NULL,
  batch_no INTEGER,
  rpa_job_id TEXT,
  status TEXT DEFAULT 'queued',
  scheduled_at TEXT DEFAULT (datetime('now','localtime')),
  finished_at TEXT,
  error_msg TEXT,
  retry_count INTEGER DEFAULT 0,
  raw_json TEXT,
  UNIQUE(shop_id, task_date),
  FOREIGN KEY (shop_id) REFERENCES shops(id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER,
  shop_id INTEGER,
  action TEXT,
  target_type TEXT,
  target_id TEXT,
  detail_json TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- ===== 定时采集调度模块 =====
CREATE TABLE IF NOT EXISTS collection_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  schedule_type TEXT DEFAULT 'daily',
  run_time TEXT NOT NULL,
  week_day INTEGER,
  target_type TEXT DEFAULT 'all',
  target_ids TEXT,
  enabled INTEGER DEFAULT 1,
  auto_suggest INTEGER DEFAULT 1,
  max_retries INTEGER DEFAULT 2,
  retry_delay_min INTEGER DEFAULT 10,
  last_run_at TEXT,
  last_run_status TEXT,
  next_run_at TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS schedule_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  schedule_id INTEGER NOT NULL,
  run_at TEXT DEFAULT (datetime('now','localtime')),
  status TEXT DEFAULT 'running',
  total_shops INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  error_msg TEXT,
  retry_count INTEGER DEFAULT 0,
  finished_at TEXT,
  FOREIGN KEY (schedule_id) REFERENCES collection_schedules(id) ON DELETE CASCADE
);

-- ===== 预警通知系统模块 =====
CREATE TABLE IF NOT EXISTS alert_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  rule_type TEXT NOT NULL,
  conditions TEXT NOT NULL,
  severity TEXT DEFAULT 'warning',
  target_type TEXT DEFAULT 'all',
  target_ids TEXT,
  enabled INTEGER DEFAULT 1,
  cooldown_hours INTEGER DEFAULT 6,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  rule_id INTEGER,
  shop_id INTEGER,
  campaign_id TEXT,
  alert_type TEXT NOT NULL,
  severity TEXT DEFAULT 'warning',
  title TEXT NOT NULL,
  message TEXT,
  metrics_json TEXT,
  status TEXT DEFAULT 'unread',
  triggered_at TEXT DEFAULT (datetime('now','localtime')),
  acknowledged_at TEXT,
  acknowledged_by INTEGER,
  FOREIGN KEY (rule_id) REFERENCES alert_rules(id) ON DELETE SET NULL,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notification_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  channel_type TEXT NOT NULL,
  webhook_url TEXT,
  email_to TEXT,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  alert_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  status TEXT DEFAULT 'pending',
  error_msg TEXT,
  sent_at TEXT,
  FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES notification_channels(id) ON DELETE CASCADE
);

-- ===== 批量操作中心模块 =====
CREATE TABLE IF NOT EXISTS batch_operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  action_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_ids TEXT,
  filters_json TEXT,
  params_json TEXT,
  status TEXT DEFAULT 'draft',
  total_items INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  preview_mode INTEGER DEFAULT 0,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  executed_at TEXT,
  finished_at TEXT,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS batch_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  batch_id INTEGER NOT NULL,
  shop_id INTEGER,
  campaign_id TEXT,
  shop_name TEXT,
  campaign_name TEXT,
  action_type TEXT NOT NULL,
  current_value REAL,
  target_value REAL,
  status TEXT DEFAULT 'pending',
  error_msg TEXT,
  rpa_job_id TEXT,
  execution_id INTEGER,
  executed_at TEXT,
  finished_at TEXT,
  FOREIGN KEY (batch_id) REFERENCES batch_operations(id) ON DELETE CASCADE
);

-- ===== 报表导出分析模块 =====
CREATE TABLE IF NOT EXISTS report_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  report_type TEXT NOT NULL,
  config_json TEXT,
  is_default INTEGER DEFAULT 0,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS report_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  template_id INTEGER,
  name TEXT NOT NULL,
  report_type TEXT NOT NULL,
  date_start TEXT,
  date_end TEXT,
  shop_ids TEXT,
  file_path TEXT,
  file_format TEXT DEFAULT 'csv',
  file_size INTEGER,
  row_count INTEGER,
  status TEXT DEFAULT 'pending',
  error_msg TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (template_id) REFERENCES report_templates(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS file_assets (
  url TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  provider TEXT,
  capability TEXT,
  model TEXT,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  cost REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'csv',
  file_name TEXT,
  status TEXT DEFAULT 'pending',
  total_rows INTEGER DEFAULT 0,
  success_rows INTEGER DEFAULT 0,
  failed_rows INTEGER DEFAULT 0,
  errors_json TEXT,
  warnings_json TEXT,
  summary_json TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_import_batches_tenant ON import_batches(tenant_id);

-- ===== 真实数据接入：商品/商品日报/订单日报/退款日报 =====
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  shop_id INTEGER NOT NULL,
  platform TEXT DEFAULT 'taobao',
  product_id TEXT NOT NULL,
  title TEXT,
  category TEXT,
  price REAL,
  status TEXT DEFAULT 'on_sale',
  raw_json TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(tenant_id, shop_id, product_id)
);

CREATE TABLE IF NOT EXISTS product_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  shop_id INTEGER NOT NULL,
  platform TEXT DEFAULT 'taobao',
  product_id TEXT NOT NULL,
  report_date TEXT NOT NULL,
  visitors INTEGER,
  payed_buyer_count INTEGER,
  pay_amount REAL,
  pay_item_count INTEGER,
  refund_amount REAL,
  refund_count INTEGER,
  conversion_rate REAL,
  avg_unit_price REAL,
  raw_json TEXT,
  collected_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(tenant_id, shop_id, product_id, report_date)
);

CREATE TABLE IF NOT EXISTS orders_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  shop_id INTEGER NOT NULL,
  platform TEXT DEFAULT 'taobao',
  report_date TEXT NOT NULL,
  order_count INTEGER,
  payed_order_count INTEGER,
  payed_buyer_count INTEGER,
  pay_amount REAL,
  refund_order_count INTEGER,
  refund_amount REAL,
  new_buyer_count INTEGER,
  old_buyer_count INTEGER,
  raw_json TEXT,
  collected_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(tenant_id, shop_id, report_date)
);

CREATE TABLE IF NOT EXISTS refunds_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  shop_id INTEGER NOT NULL,
  platform TEXT DEFAULT 'taobao',
  report_date TEXT NOT NULL,
  refund_count INTEGER,
  refund_amount REAL,
  refund_item_count INTEGER,
  refund_rate REAL,
  reason_top TEXT,
  raw_json TEXT,
  collected_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(tenant_id, shop_id, report_date)
);

CREATE TABLE IF NOT EXISTS kb_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER NOT NULL,
  doc_id INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  tokens INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON kb_chunks(tenant_id, user_id, doc_id);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  invoice_no TEXT UNIQUE,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  billing_cycle TEXT DEFAULT 'monthly',
  status TEXT DEFAULT 'draft',
  currency TEXT DEFAULT 'CNY',
  subtotal REAL DEFAULT 0,
  tax_rate REAL DEFAULT 0,
  tax_amount REAL DEFAULT 0,
  total REAL DEFAULT 0,
  amount_paid REAL DEFAULT 0,
  issued_at TEXT,
  due_at TEXT,
  paid_at TEXT,
  note TEXT,
  meta_json TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant ON invoices(tenant_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);

CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  invoice_id INTEGER NOT NULL,
  item_type TEXT NOT NULL,
  description TEXT,
  quantity REAL DEFAULT 0,
  unit_price REAL DEFAULT 0,
  amount REAL DEFAULT 0,
  meta_json TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(tenant_id, invoice_id);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  invoice_id INTEGER NOT NULL,
  amount REAL DEFAULT 0,
  method TEXT DEFAULT 'manual',
  reference TEXT,
  paid_at TEXT,
  note TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(tenant_id, invoice_id);
`);

// 默认租户（tenant_id 默认 1 的基础行；幂等，保证新库/测试库也有可用的租户 1）
db.prepare("INSERT OR IGNORE INTO tenants (id, name, slug, status, plan) VALUES (1, '默认租户', 'default', 'active', 'internal')").run();

// ===== Schema 迁移：agent_runs 新增字段 =====
if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'session_version')) {
  db.exec('ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0');
}
const existingCols = db.prepare("PRAGMA table_info(agent_runs)").all().map(c => c.name);
const newCols = [
  ['source', 'TEXT DEFAULT NULL'],
  ['tokens_est', 'INTEGER DEFAULT 0'],
  ['duration_ms', 'INTEGER DEFAULT 0'],
  ['extra', 'TEXT DEFAULT NULL'],
  ['result_parsed', 'TEXT DEFAULT NULL'],
  ['provider', 'TEXT DEFAULT NULL'],
  ['model', 'TEXT DEFAULT NULL'],
  ['tokens_in', 'INTEGER DEFAULT 0'],
  ['tokens_out', 'INTEGER DEFAULT 0'],
  ['cost', 'REAL DEFAULT 0']
];
for (const [col, def] of newCols) {
  if (!existingCols.includes(col)) {
    db.exec(`ALTER TABLE agent_runs ADD COLUMN ${col} ${def}`);
  }
}

module.exports = { db };
