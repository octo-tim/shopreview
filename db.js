const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'reviews.db');

let db;

function getDb() {
  if (!db) {
    const fs = require('fs');
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      product_code TEXT,
      mall_name TEXT,
      store_name TEXT,
      category TEXT,
      tracking_keyword TEXT,
      image_url TEXT,
      active INTEGER DEFAULT 1,
      last_crawled_at TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      review_id TEXT,
      author TEXT,
      rating INTEGER,
      content TEXT,
      option_info TEXT,
      helpful_count INTEGER DEFAULT 0,
      has_photo INTEGER DEFAULT 0,
      review_date TEXT,
      crawled_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (product_id) REFERENCES products(id),
      UNIQUE(product_id, review_id)
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      keyword TEXT,
      search_rank INTEGER,
      is_ad INTEGER DEFAULT 0,
      price INTEGER,
      original_price INTEGER,
      review_count INTEGER,
      rating REAL,
      recorded_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_product ON snapshots(product_id, recorded_at);

    CREATE TABLE IF NOT EXISTS ai_analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER,
      analysis_type TEXT,
      content TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS crawl_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER,
      crawl_type TEXT,
      status TEXT,
      reviews_found INTEGER DEFAULT 0,
      new_reviews INTEGER DEFAULT 0,
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS search_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT UNIQUE,
      last_searched_at TEXT DEFAULT (datetime('now','localtime')),
      search_count INTEGER DEFAULT 1
    );
  `);

  // 마이그레이션: products.review_period 컬럼 추가 (안전하게)
  try {
    const cols = db.prepare("PRAGMA table_info(products)").all();
    const hasPeriod = cols.some(c => c.name === 'review_period');
    if (!hasPeriod) {
      db.exec("ALTER TABLE products ADD COLUMN review_period TEXT DEFAULT '1m'");
      console.log('✅ products.review_period 컬럼 추가됨');
    }
  } catch (e) {
    console.error('마이그레이션 실패:', e.message);
  }
}

module.exports = { getDb };
