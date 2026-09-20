// ===== 阶段 3：真实数据接入的数据模型扩展 =====
// - 新增 products / product_daily / orders_daily / refunds_daily
// - shops +platform；ad_campaigns +platform/account_id/raw_json
// - collection_tasks +raw_json（原始报文留痕）
// - import_batches +warnings_json（数据质量告警）
const NEW_TABLES = {
  sqlite: `
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
);`,
  postgres: `
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
);`
};

module.exports = {
  id: '0006_stage3_data_model',
  up: async (db) => {
    const pg = db.dialect === 'postgres';
    await db.exec(pg ? NEW_TABLES.postgres : NEW_TABLES.sqlite);

    const addCol = async (table, column, def) => {
      if (pg) {
        await db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${def}`);
      } else {
        const cols = (await db.all(`PRAGMA table_info(${table})`)).map(c => c.name);
        if (!cols.includes(column)) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
      }
    };

    await addCol('shops', 'platform', "TEXT DEFAULT 'taobao'");
    await addCol('ad_campaigns', 'platform', "TEXT DEFAULT 'taobao'");
    await addCol('ad_campaigns', 'account_id', 'TEXT');
    await addCol('ad_campaigns', 'raw_json', 'TEXT');
    await addCol('collection_tasks', 'raw_json', 'TEXT');
    await addCol('import_batches', 'warnings_json', 'TEXT');

    for (const t of ['products', 'product_daily', 'orders_daily', 'refunds_daily']) {
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_${t}_tenant ON ${t}(tenant_id)`);
    }
    await db.exec('CREATE INDEX IF NOT EXISTS idx_products_shop ON products(tenant_id, shop_id, product_id)');
    for (const t of ['product_daily', 'orders_daily', 'refunds_daily']) {
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_${t}_shop_date ON ${t}(tenant_id, shop_id, report_date)`);
    }
  }
};
