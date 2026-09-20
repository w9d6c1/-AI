-- ===== Postgres Schema（与 server/db.js 的 SQLite schema 对齐）=====
-- 时间列保持 TEXT 字符串语义，默认值与 SQLite datetime('now','localtime') 格式一致。
-- 数值列 REAL → DOUBLE PRECISION；自增 → SERIAL。

CREATE TABLE IF NOT EXISTS tenants (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  status TEXT DEFAULT 'active',
  plan TEXT DEFAULT 'trial',
  max_shops INTEGER DEFAULT 50,
  max_ai_calls_per_month INTEGER DEFAULT 100000,
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
);
INSERT INTO tenants (id, name, slug, status, plan) VALUES (1, '默认租户', 'default', 'active', 'internal')
  ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS teams (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  owner_id INTEGER,
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  team_id INTEGER,
  role TEXT DEFAULT 'member',
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  session_version INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (team_id) REFERENCES teams(id)
);

CREATE TABLE IF NOT EXISTS chats (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  chat_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  agent_name TEXT,
  input TEXT,
  result TEXT,
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  source TEXT DEFAULT NULL,
  tokens_est INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  extra TEXT DEFAULT NULL,
  result_parsed TEXT DEFAULT NULL,
  provider TEXT DEFAULT NULL,
  model TEXT DEFAULT NULL,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  cost DOUBLE PRECISION DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS canvas_boards (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER NOT NULL,
  name TEXT DEFAULT '未命名画板',
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS canvas_elements (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  board_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  x DOUBLE PRECISION DEFAULT 0,
  y DOUBLE PRECISION DEFAULT 0,
  text TEXT DEFAULT '',
  color TEXT DEFAULT '#0d9488',
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  FOREIGN KEY (board_id) REFERENCES canvas_boards(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS competitor_reports (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER NOT NULL,
  target TEXT NOT NULL,
  report TEXT NOT NULL,
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  icon TEXT DEFAULT '📊',
  color TEXT DEFAULT '#f0fdfa',
  "desc" TEXT DEFAULT '',
  freq TEXT DEFAULT '每日 09:00',
  enabled INTEGER DEFAULT 1,
  last_run_at TEXT,
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS task_logs (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  task_id INTEGER,
  user_id INTEGER NOT NULL,
  msg TEXT NOT NULL,
  status TEXT DEFAULT 'info',
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS courses (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  cat TEXT DEFAULT '运营',
  icon TEXT DEFAULT '📚',
  color TEXT DEFAULT 'linear-gradient(135deg,#0d9488,#14b8a6)',
  duration TEXT DEFAULT '6课时',
  level TEXT DEFAULT '入门',
  "desc" TEXT DEFAULT '',
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS course_progress (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER NOT NULL,
  course_id INTEGER NOT NULL,
  progress INTEGER DEFAULT 0,
  chapters_done INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE(user_id, course_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (course_id) REFERENCES courses(id)
);

CREATE TABLE IF NOT EXISTS images (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  style TEXT DEFAULT '',
  ratio TEXT DEFAULT '1:1',
  url TEXT,
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS kb_docs (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  size INTEGER DEFAULT 0,
  status TEXT DEFAULT 'indexed',
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS shop_groups (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL UNIQUE,
  batch_no INTEGER NOT NULL,
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS shops (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  shop_name TEXT NOT NULL,
  wangwang_id TEXT,
  qianniu_account TEXT NOT NULL,
  rpa_robot_id TEXT,
  group_id INTEGER,
  platform TEXT DEFAULT 'taobao',
  status TEXT DEFAULT 'active',
  daily_adjust_limit INTEGER DEFAULT 5,
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  FOREIGN KEY (group_id) REFERENCES shop_groups(id)
);

CREATE TABLE IF NOT EXISTS user_shop_permissions (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER NOT NULL,
  shop_id INTEGER NOT NULL,
  permission_level TEXT DEFAULT 'view',
  UNIQUE(user_id, shop_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS daily_reports (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  shop_id INTEGER NOT NULL,
  report_date TEXT NOT NULL,
  visitors INTEGER,
  payed_buyer_count INTEGER,
  pay_amount DOUBLE PRECISION,
  pay_item_count INTEGER,
  conversion_rate DOUBLE PRECISION,
  avg_unit_price DOUBLE PRECISION,
  raw_json TEXT,
  collected_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE(shop_id, report_date),
  FOREIGN KEY (shop_id) REFERENCES shops(id)
);

CREATE TABLE IF NOT EXISTS ad_campaigns (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  shop_id INTEGER NOT NULL,
  platform TEXT DEFAULT 'taobao',
  account_id TEXT,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT NOT NULL,
  campaign_type TEXT DEFAULT 'standard',
  report_date TEXT NOT NULL,
  cost DOUBLE PRECISION NOT NULL,
  impressions INTEGER NOT NULL,
  clicks INTEGER NOT NULL,
  ctr DOUBLE PRECISION,
  cpc DOUBLE PRECISION,
  pay_amount DOUBLE PRECISION,
  roi DOUBLE PRECISION,
  status TEXT DEFAULT 'running',
  raw_json TEXT,
  collected_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE(shop_id, campaign_id, report_date),
  FOREIGN KEY (shop_id) REFERENCES shops(id)
);

CREATE TABLE IF NOT EXISTS suggestions (
  id SERIAL PRIMARY KEY,
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
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  FOREIGN KEY (shop_id) REFERENCES shops(id),
  FOREIGN KEY (reviewed_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS suggestion_items (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  suggestion_id INTEGER NOT NULL,
  campaign_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  current_value DOUBLE PRECISION,
  suggested_value DOUBLE PRECISION,
  reason TEXT,
  confidence DOUBLE PRECISION DEFAULT 0.5,
  status TEXT DEFAULT 'pending',
  FOREIGN KEY (suggestion_id) REFERENCES suggestions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS executions (
  id SERIAL PRIMARY KEY,
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
  actual_value DOUBLE PRECISION,
  expected_value DOUBLE PRECISION,
  before_value DOUBLE PRECISION,
  is_auto INTEGER DEFAULT 0,
  approved_by INTEGER,
  approved_at TEXT,
  not_before TEXT,
  rollback_of INTEGER,
  reason TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  FOREIGN KEY (shop_id) REFERENCES shops(id),
  FOREIGN KEY (suggestion_item_id) REFERENCES suggestion_items(id)
);

CREATE TABLE IF NOT EXISTS collection_tasks (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  shop_id INTEGER NOT NULL,
  task_date TEXT NOT NULL,
  batch_no INTEGER,
  rpa_job_id TEXT,
  status TEXT DEFAULT 'queued',
  scheduled_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  finished_at TEXT,
  error_msg TEXT,
  retry_count INTEGER DEFAULT 0,
  raw_json TEXT,
  CONSTRAINT uq_collection_tasks_tenant_shop_date UNIQUE (tenant_id, shop_id, task_date),
  FOREIGN KEY (shop_id) REFERENCES shops(id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER,
  shop_id INTEGER,
  action TEXT,
  target_type TEXT,
  target_id TEXT,
  detail_json TEXT,
  ip_address TEXT,
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS collection_schedules (
  id SERIAL PRIMARY KEY,
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
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS schedule_runs (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  schedule_id INTEGER NOT NULL,
  run_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  status TEXT DEFAULT 'running',
  total_shops INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  error_msg TEXT,
  retry_count INTEGER DEFAULT 0,
  finished_at TEXT,
  FOREIGN KEY (schedule_id) REFERENCES collection_schedules(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  rule_type TEXT NOT NULL,
  conditions TEXT NOT NULL,
  severity TEXT DEFAULT 'warning',
  target_type TEXT DEFAULT 'all',
  target_ids TEXT,
  enabled INTEGER DEFAULT 1,
  cooldown_hours INTEGER DEFAULT 6,
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS alerts (
  id SERIAL PRIMARY KEY,
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
  triggered_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  acknowledged_at TEXT,
  acknowledged_by INTEGER,
  FOREIGN KEY (rule_id) REFERENCES alert_rules(id) ON DELETE SET NULL,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notification_channels (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  channel_type TEXT NOT NULL,
  webhook_url TEXT,
  email_to TEXT,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  alert_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  status TEXT DEFAULT 'pending',
  error_msg TEXT,
  sent_at TEXT,
  FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES notification_channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS batch_operations (
  id SERIAL PRIMARY KEY,
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
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  executed_at TEXT,
  finished_at TEXT,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS batch_items (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  batch_id INTEGER NOT NULL,
  shop_id INTEGER,
  campaign_id TEXT,
  shop_name TEXT,
  campaign_name TEXT,
  action_type TEXT NOT NULL,
  current_value DOUBLE PRECISION,
  target_value DOUBLE PRECISION,
  status TEXT DEFAULT 'pending',
  error_msg TEXT,
  rpa_job_id TEXT,
  execution_id INTEGER,
  executed_at TEXT,
  finished_at TEXT,
  FOREIGN KEY (batch_id) REFERENCES batch_operations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS report_templates (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  report_type TEXT NOT NULL,
  config_json TEXT,
  is_default INTEGER DEFAULT 0,
  created_by INTEGER,
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS report_records (
  id SERIAL PRIMARY KEY,
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
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  FOREIGN KEY (template_id) REFERENCES report_templates(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS file_assets (
  url TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  provider TEXT,
  capability TEXT,
  model TEXT,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  cost DOUBLE PRECISION DEFAULT 0,
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS import_batches (
  id SERIAL PRIMARY KEY,
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
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  shop_id INTEGER NOT NULL,
  platform TEXT DEFAULT 'taobao',
  product_id TEXT NOT NULL,
  title TEXT,
  category TEXT,
  price DOUBLE PRECISION,
  status TEXT DEFAULT 'on_sale',
  raw_json TEXT,
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE(tenant_id, shop_id, product_id)
);

CREATE TABLE IF NOT EXISTS product_daily (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  shop_id INTEGER NOT NULL,
  platform TEXT DEFAULT 'taobao',
  product_id TEXT NOT NULL,
  report_date TEXT NOT NULL,
  visitors INTEGER,
  payed_buyer_count INTEGER,
  pay_amount DOUBLE PRECISION,
  pay_item_count INTEGER,
  refund_amount DOUBLE PRECISION,
  refund_count INTEGER,
  conversion_rate DOUBLE PRECISION,
  avg_unit_price DOUBLE PRECISION,
  raw_json TEXT,
  collected_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE(tenant_id, shop_id, product_id, report_date)
);

CREATE TABLE IF NOT EXISTS orders_daily (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  shop_id INTEGER NOT NULL,
  platform TEXT DEFAULT 'taobao',
  report_date TEXT NOT NULL,
  order_count INTEGER,
  payed_order_count INTEGER,
  payed_buyer_count INTEGER,
  pay_amount DOUBLE PRECISION,
  refund_order_count INTEGER,
  refund_amount DOUBLE PRECISION,
  new_buyer_count INTEGER,
  old_buyer_count INTEGER,
  raw_json TEXT,
  collected_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE(tenant_id, shop_id, report_date)
);

CREATE TABLE IF NOT EXISTS refunds_daily (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  shop_id INTEGER NOT NULL,
  platform TEXT DEFAULT 'taobao',
  report_date TEXT NOT NULL,
  refund_count INTEGER,
  refund_amount DOUBLE PRECISION,
  refund_item_count INTEGER,
  refund_rate DOUBLE PRECISION,
  reason_top TEXT,
  raw_json TEXT,
  collected_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE(tenant_id, shop_id, report_date)
);

CREATE TABLE IF NOT EXISTS kb_chunks (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER NOT NULL,
  doc_id INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  tokens INTEGER DEFAULT 0,
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
);
