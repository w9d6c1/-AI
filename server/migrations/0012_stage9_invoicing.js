// ===== 阶段 9：多租户运营——出账与发票 =====
// 新增 invoices / invoice_items / payments；tenants +tax_rate。
// 新库由 db.js / pg-schema.sql 直接建表建列；既有库经本迁移创建（幂等）。
const SQLITE = `
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
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(tenant_id, invoice_id);`;

const PG = `
CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  invoice_no TEXT UNIQUE,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  billing_cycle TEXT DEFAULT 'monthly',
  status TEXT DEFAULT 'draft',
  currency TEXT DEFAULT 'CNY',
  subtotal DOUBLE PRECISION DEFAULT 0,
  tax_rate DOUBLE PRECISION DEFAULT 0,
  tax_amount DOUBLE PRECISION DEFAULT 0,
  total DOUBLE PRECISION DEFAULT 0,
  amount_paid DOUBLE PRECISION DEFAULT 0,
  issued_at TEXT,
  due_at TEXT,
  paid_at TEXT,
  note TEXT,
  meta_json TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant ON invoices(tenant_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);

CREATE TABLE IF NOT EXISTS invoice_items (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  invoice_id INTEGER NOT NULL,
  item_type TEXT NOT NULL,
  description TEXT,
  quantity DOUBLE PRECISION DEFAULT 0,
  unit_price DOUBLE PRECISION DEFAULT 0,
  amount DOUBLE PRECISION DEFAULT 0,
  meta_json TEXT,
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(tenant_id, invoice_id);

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  invoice_id INTEGER NOT NULL,
  amount DOUBLE PRECISION DEFAULT 0,
  method TEXT DEFAULT 'manual',
  reference TEXT,
  paid_at TEXT,
  note TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(tenant_id, invoice_id);`;

module.exports = {
  id: '0012_stage9_invoicing',
  up: async (db) => {
    const pg = db.dialect === 'postgres';
    await db.exec(pg ? PG : SQLITE);

    if (pg) {
      await db.exec('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS tax_rate DOUBLE PRECISION DEFAULT 0');
    } else {
      const cols = (await db.all('PRAGMA table_info(tenants)')).map(c => c.name);
      if (!cols.includes('tax_rate')) await db.exec('ALTER TABLE tenants ADD COLUMN tax_rate REAL DEFAULT 0');
    }
  }
};
