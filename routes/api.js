const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { crawlProductReviews, crawlAllProducts, takeProductSnapshot } = require('../crawler/smartstore');
const { searchNaverShopping } = require('../crawler/search');

// ─── Keyword Search ─────────────────────────────────

// POST search Naver Shopping by keyword
router.post('/search', async (req, res) => {
  const { keyword, limit = 40 } = req.body;
  if (!keyword) return res.status(400).json({ error: '키워드를 입력해주세요' });

  try {
    const products = await searchNaverShopping(keyword, limit);
    
    // Save search history
    const db = getDb();
    db.prepare(`
      INSERT INTO search_history (keyword) VALUES (?)
      ON CONFLICT(keyword) DO UPDATE SET 
        last_searched_at = datetime('now','localtime'),
        search_count = search_count + 1
    `).run(keyword);

    res.json({ keyword, products });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET recent search history
router.get('/search-history', (req, res) => {
  const db = getDb();
  const history = db.prepare('SELECT * FROM search_history ORDER BY last_searched_at DESC LIMIT 10').all();
  res.json(history);
});

// ─── Products (Tracked) ─────────────────────────────

// GET all tracked products
router.get('/products', (req, res) => {
  const db = getDb();
  const products = db.prepare(`
    SELECT p.*,
      COUNT(DISTINCT r.id) as review_count,
      ROUND(AVG(r.rating), 1) as avg_rating,
      (SELECT search_rank FROM snapshots WHERE product_id = p.id ORDER BY recorded_at DESC LIMIT 1) as current_rank,
      (SELECT price FROM snapshots WHERE product_id = p.id ORDER BY recorded_at DESC LIMIT 1) as current_price,
      (SELECT recorded_at FROM snapshots WHERE product_id = p.id ORDER BY recorded_at DESC LIMIT 1) as last_snapshot_at
    FROM products p
    LEFT JOIN reviews r ON r.product_id = p.id
    WHERE p.active = 1
    GROUP BY p.id
    ORDER BY p.created_at DESC
  `).all();
  res.json(products);
});

// POST add tracked product (from search result)
router.post('/products', (req, res) => {
  const { name, url, tracking_keyword, product_code, mall_name, image_url, category, brand, product_category } = req.body;
  if (!name || !url) return res.status(400).json({ error: '상품명과 URL이 필요합니다' });

  const db = getDb();
  
  const count = db.prepare('SELECT COUNT(*) as cnt FROM products WHERE active = 1').get();
  if (count.cnt >= 10) return res.status(400).json({ error: '최대 10개 상품까지 트래킹 가능합니다' });

  try {
    const result = db.prepare(`
      INSERT INTO products (name, url, tracking_keyword, product_code, mall_name, image_url, category, brand, product_category)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, url.trim(), tracking_keyword || null, product_code || null, mall_name || null, image_url || null, category || null, brand || null, product_category || null);
    
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid);
    res.json(product);
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      // Reactivate if soft-deleted
      const existing = db.prepare('SELECT * FROM products WHERE url = ?').get(url.trim());
      if (existing && !existing.active) {
        db.prepare('UPDATE products SET active = 1, tracking_keyword = ? WHERE id = ?').run(tracking_keyword || null, existing.id);
        return res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(existing.id));
      }
      res.status(400).json({ error: '이미 트래킹 중인 상품입니다' });
    } else {
      res.status(500).json({ error: e.message });
    }
  }
});

// PATCH update tracking keyword
router.patch('/products/:id', (req, res) => {
  const { tracking_keyword, name, category } = req.body;
  const db = getDb();
  
  const fields = [];
  const values = [];
  if (tracking_keyword !== undefined) { fields.push('tracking_keyword = ?'); values.push(tracking_keyword); }
  if (name !== undefined) { fields.push('name = ?'); values.push(name); }
  if (category !== undefined) { fields.push('category = ?'); values.push(category); }
  
  if (fields.length === 0) return res.status(400).json({ error: '업데이트할 필드 없음' });
  
  values.push(req.params.id);
  db.prepare(`UPDATE products SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  res.json({ success: true });
});

// DELETE product
router.delete('/products/:id', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// POST crawl single product (reviews)
router.post('/products/:id/crawl', async (req, res) => {
  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: '상품 없음' });

  try {
    const snap = await takeProductSnapshot(product);
    const rev = await crawlProductReviews(product);
    res.json({ snapshot: snap, reviews: rev });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST take snapshot only
router.post('/products/:id/snapshot', async (req, res) => {
  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: '상품 없음' });

  try {
    const result = await takeProductSnapshot(product);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/crawl-all', async (req, res) => {
  try {
    const results = await crawlAllProducts();
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Snapshots / Trends ─────────────────────────────

// GET snapshots (trend data) for a product
router.get('/products/:id/snapshots', (req, res) => {
  const db = getDb();
  const { limit = 200 } = req.query;
  const snapshots = db.prepare(`
    SELECT * FROM snapshots WHERE product_id = ?
    ORDER BY recorded_at ASC LIMIT ?
  `).all(req.params.id, limit);
  res.json(snapshots);
});

// GET trend summary (latest vs oldest comparison)
router.get('/products/:id/trends', (req, res) => {
  const db = getDb();
  const id = req.params.id;
  
  const latest = db.prepare('SELECT * FROM snapshots WHERE product_id = ? ORDER BY recorded_at DESC LIMIT 1').get(id);
  const oldest = db.prepare('SELECT * FROM snapshots WHERE product_id = ? ORDER BY recorded_at ASC LIMIT 1').get(id);
  const dayAgo = db.prepare(`
    SELECT * FROM snapshots WHERE product_id = ? 
    AND recorded_at < datetime('now', '-1 day', 'localtime')
    ORDER BY recorded_at DESC LIMIT 1
  `).get(id);

  res.json({ latest, oldest, dayAgo });
});

// ─── Reviews ────────────────────────────────────────

router.get('/products/:id/reviews', (req, res) => {
  const db = getDb();
  const { page = 1, limit = 20, rating, sort = 'recent' } = req.query;
  const offset = (page - 1) * limit;

  let where = 'WHERE r.product_id = ?';
  const params = [req.params.id];

  if (rating) { where += ' AND r.rating = ?'; params.push(rating); }

  const orderBy = sort === 'helpful' ? 'r.helpful_count DESC' : 'r.review_date DESC, r.crawled_at DESC';
  const reviews = db.prepare(`SELECT r.* FROM reviews r ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) as cnt FROM reviews r ${where}`).get(...params);
  res.json({ reviews, total: total.cnt, page: parseInt(page), limit: parseInt(limit) });
});

router.get('/products/:id/stats', (req, res) => {
  const db = getDb();
  const id = req.params.id;

  const overall = db.prepare(`
    SELECT COUNT(*) as total, ROUND(AVG(rating),1) as avg_rating,
      SUM(CASE WHEN has_photo = 1 THEN 1 ELSE 0 END) as photo_count
    FROM reviews WHERE product_id = ?
  `).get(id);

  const distribution = db.prepare(`SELECT rating, COUNT(*) as count FROM reviews WHERE product_id = ? GROUP BY rating ORDER BY rating DESC`).all(id);

  const reviews = db.prepare('SELECT content FROM reviews WHERE product_id = ? AND content IS NOT NULL').all(id);
  const keywords = extractKeywords(reviews.map(r => r.content));

  res.json({ overall, distribution, keywords });
});

router.get('/reviews', (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const offset = parseInt(req.query.offset) || 0;
  
  const reviews = db.prepare(`
    SELECT r.*, p.name as product_name FROM reviews r
    JOIN products p ON p.id = r.product_id
    WHERE p.active = 1
    ORDER BY r.crawled_at DESC LIMIT ? OFFSET ?
  `).all(limit, offset);
  
  const total = db.prepare(`
    SELECT COUNT(*) as cnt FROM reviews r
    JOIN products p ON p.id = r.product_id
    WHERE p.active = 1
  `).get().cnt;
  
  res.json({ reviews, total, limit, offset, hasMore: offset + reviews.length < total });
});

// ─── AI Analysis ────────────────────────────────────

router.get('/products/:id/analyses', (req, res) => {
  const db = getDb();
  const analyses = db.prepare(`SELECT * FROM ai_analyses WHERE product_id = ? ORDER BY created_at DESC LIMIT 10`).all(req.params.id);
  res.json(analyses);
});

router.post('/products/:id/analyses', (req, res) => {
  const { analysis_type, content } = req.body;
  const db = getDb();
  const result = db.prepare(`INSERT INTO ai_analyses (product_id, analysis_type, content) VALUES (?, ?, ?)`).run(req.params.id, analysis_type, content);
  res.json({ id: result.lastInsertRowid });
});

// ─── Helpers ────────────────────────────────────────

function extractKeywords(texts) {
  const stopWords = new Set([
    '이','가','을','를','은','는','의','에','도','로','와','과','한',
    '하다','있다','없다','그','이런','저런','너무','정말','진짜','매우',
    '좀','더','또','잘','못','안','다','것','수','때','제품','상품',
    '구매','배송','포장','사용','사서','왔어요','좋아요','같아요','해요'
  ]);

  const freq = {};
  texts.forEach(text => {
    if (!text) return;
    const words = text.replace(/[^\w\s가-힣]/g, ' ').split(/\s+/);
    words.forEach(w => {
      if (w.length >= 2 && !stopWords.has(w)) freq[w] = (freq[w] || 0) + 1;
    });
  });

  return Object.entries(freq).sort((a,b) => b[1]-a[1]).slice(0, 30).map(([word, count]) => ({ word, count }));
}


// ═══════════════════════════════════════════════════════════
// 외부 크롤러 (NCP 서버) 연동 API
// ═══════════════════════════════════════════════════════════

// GET: 외부 크롤러가 트래킹 상품 목록 조회
router.get('/external/products', (req, res) => {
  const token = req.headers['x-crawler-token'];
  if (!process.env.CRAWLER_TOKEN || token !== process.env.CRAWLER_TOKEN) {
    return res.status(401).json({ error: '인증 실패' });
  }
  
  const db = getDb();
  const products = db.prepare(`
    SELECT id, name, url, tracking_keyword, last_crawled_at, review_period, brand, product_category
    FROM products WHERE active = 1
    ORDER BY (last_crawled_at IS NULL) DESC, last_crawled_at ASC
  `).all();
  
  res.json(products);
});

// POST: 외부 크롤러가 수집한 리뷰 업로드
router.post('/external/reviews', (req, res) => {
  const token = req.headers['x-crawler-token'];
  if (!process.env.CRAWLER_TOKEN || token !== process.env.CRAWLER_TOKEN) {
    return res.status(401).json({ error: '인증 실패' });
  }
  
  const { product_id, reviews } = req.body;
  if (!product_id || !Array.isArray(reviews)) {
    return res.status(400).json({ error: 'product_id, reviews 배열 필요' });
  }
  
  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(product_id);
  if (!product) return res.status(404).json({ error: '상품 없음' });
  
  const insertReview = db.prepare(`
    INSERT OR IGNORE INTO reviews 
    (product_id, review_id, author, rating, content, option_info, helpful_count, has_photo, review_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  let newCount = 0;
  const insertMany = db.transaction((list) => {
    for (const r of list) {
      const result = insertReview.run(
        product_id,
        r.reviewId || 'ext_' + Date.now() + '_' + Math.random().toString(36).substr(2,9),
        r.author || '',
        r.rating || null,
        r.content || '',
        r.option || '',
        r.helpful || 0,
        r.hasPhoto ? 1 : 0,
        r.date || ''
      );
      if (result.changes > 0) newCount++;
    }
  });
  
  try {
    insertMany(reviews);
    db.prepare(`UPDATE products SET last_crawled_at = datetime('now','localtime') WHERE id = ?`).run(product_id);
    db.prepare(`INSERT INTO crawl_logs (product_id, crawl_type, status, reviews_found, new_reviews) VALUES (?, 'external', 'success', ?, ?)`)
      .run(product_id, reviews.length, newCount);
    
    console.log('📥 외부 크롤러: [' + product.name.substring(0,40) + '] ' + reviews.length + '개 수신, ' + newCount + '개 신규');
    res.json({ success: true, received: reviews.length, newCount });
  } catch (e) {
    console.error('외부 리뷰 저장 실패: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});


// POST: 외부 크롤러가 리뷰 수/별점 스냅샷 업데이트
router.post('/external/snapshot', (req, res) => {
  const token = req.headers['x-crawler-token'];
  if (!process.env.CRAWLER_TOKEN || token !== process.env.CRAWLER_TOKEN) {
    return res.status(401).json({ error: '인증 실패' });
  }
  
  const { product_id, review_count, rating } = req.body;
  if (!product_id) return res.status(400).json({ error: 'product_id 필요' });
  
  const db = getDb();
  try {
    // 가장 최근 snapshot 찾아서 review_count, rating 업데이트
    const latest = db.prepare(`
      SELECT id FROM snapshots 
      WHERE product_id = ? 
      ORDER BY recorded_at DESC 
      LIMIT 1
    `).get(product_id);
    
    if (latest) {
      db.prepare(`
        UPDATE snapshots 
        SET review_count = COALESCE(?, review_count), 
            rating = COALESCE(?, rating) 
        WHERE id = ?
      `).run(review_count, rating, latest.id);
      
      console.log('📊 스냅샷 업데이트: product_id=' + product_id + ', reviews=' + review_count + ', rating=' + rating);
      res.json({ success: true, snapshot_id: latest.id });
    } else {
      // 스냅샷이 없으면 새로 생성
      db.prepare(`
        INSERT INTO snapshots (product_id, review_count, rating)
        VALUES (?, ?, ?)
      `).run(product_id, review_count || null, rating || null);
      
      res.json({ success: true, created: true });
    }
  } catch (e) {
    console.error('스냅샷 업데이트 실패: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});


// PATCH: 상품의 리뷰 수집 기간 업데이트
router.patch('/products/:id/period', (req, res) => {
  const { id } = req.params;
  const { review_period } = req.body;
  
  const validPeriods = ['1w', '1m', '3m', '6m', 'all'];
  if (!validPeriods.includes(review_period)) {
    return res.status(400).json({ error: '유효한 기간: 1w, 1m, 3m, 6m, all' });
  }
  
  const db = getDb();
  try {
    const result = db.prepare('UPDATE products SET review_period = ? WHERE id = ?').run(review_period, id);
    if (result.changes === 0) return res.status(404).json({ error: '상품 없음' });
    res.json({ success: true, review_period });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ─── Brands & Categories Master ──────────────────────

// 브랜드 목록 조회
router.get('/brands', (req, res) => {
  const db = getDb();
  const brands = db.prepare(`
    SELECT b.*, COUNT(p.id) as product_count
    FROM brands b
    LEFT JOIN products p ON p.brand = b.name AND p.active = 1
    GROUP BY b.id
    ORDER BY b.is_own DESC, b.name ASC
  `).all();
  res.json(brands);
});

// 브랜드 추가
router.post('/brands', (req, res) => {
  const { name, is_own, memo } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '브랜드명이 필요합니다' });
  
  const db = getDb();
  try {
    const result = db.prepare('INSERT INTO brands (name, is_own, memo) VALUES (?, ?, ?)')
      .run(name.trim(), is_own ? 1 : 0, memo || null);
    res.json(db.prepare('SELECT * FROM brands WHERE id = ?').get(result.lastInsertRowid));
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      res.status(400).json({ error: '이미 존재하는 브랜드입니다' });
    } else {
      res.status(500).json({ error: e.message });
    }
  }
});

// 브랜드 수정
router.patch('/brands/:id', (req, res) => {
  const { name, is_own, memo } = req.body;
  const db = getDb();
  try {
    const updates = [];
    const params = [];
    if (name !== undefined) { updates.push('name = ?'); params.push(name.trim()); }
    if (is_own !== undefined) { updates.push('is_own = ?'); params.push(is_own ? 1 : 0); }
    if (memo !== undefined) { updates.push('memo = ?'); params.push(memo || null); }
    if (!updates.length) return res.status(400).json({ error: '변경 항목 없음' });
    params.push(req.params.id);
    
    const result = db.prepare(`UPDATE brands SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    if (!result.changes) return res.status(404).json({ error: '브랜드 없음' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 브랜드 삭제
router.delete('/brands/:id', (req, res) => {
  const db = getDb();
  const brand = db.prepare('SELECT * FROM brands WHERE id = ?').get(req.params.id);
  if (!brand) return res.status(404).json({ error: '브랜드 없음' });
  
  const usingCount = db.prepare('SELECT COUNT(*) as cnt FROM products WHERE brand = ? AND active = 1').get(brand.name).cnt;
  if (usingCount > 0) {
    return res.status(400).json({ error: `이 브랜드를 사용 중인 상품이 ${usingCount}개 있습니다` });
  }
  
  db.prepare('DELETE FROM brands WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// 카테고리 목록 조회
router.get('/categories', (req, res) => {
  const db = getDb();
  const categories = db.prepare(`
    SELECT c.*, COUNT(p.id) as product_count
    FROM categories c
    LEFT JOIN products p ON p.product_category = c.name AND p.active = 1
    GROUP BY c.id
    ORDER BY c.name ASC
  `).all();
  res.json(categories);
});

// 카테고리 추가
router.post('/categories', (req, res) => {
  const { name, memo } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '카테고리명이 필요합니다' });
  
  const db = getDb();
  try {
    const result = db.prepare('INSERT INTO categories (name, memo) VALUES (?, ?)')
      .run(name.trim(), memo || null);
    res.json(db.prepare('SELECT * FROM categories WHERE id = ?').get(result.lastInsertRowid));
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      res.status(400).json({ error: '이미 존재하는 카테고리입니다' });
    } else {
      res.status(500).json({ error: e.message });
    }
  }
});

// 카테고리 수정
router.patch('/categories/:id', (req, res) => {
  const { name, memo } = req.body;
  const db = getDb();
  try {
    const updates = [];
    const params = [];
    if (name !== undefined) { updates.push('name = ?'); params.push(name.trim()); }
    if (memo !== undefined) { updates.push('memo = ?'); params.push(memo || null); }
    if (!updates.length) return res.status(400).json({ error: '변경 항목 없음' });
    params.push(req.params.id);
    
    const result = db.prepare(`UPDATE categories SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    if (!result.changes) return res.status(404).json({ error: '카테고리 없음' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 카테고리 삭제
router.delete('/categories/:id', (req, res) => {
  const db = getDb();
  const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
  if (!cat) return res.status(404).json({ error: '카테고리 없음' });
  
  const usingCount = db.prepare('SELECT COUNT(*) as cnt FROM products WHERE product_category = ? AND active = 1').get(cat.name).cnt;
  if (usingCount > 0) {
    return res.status(400).json({ error: `이 카테고리를 사용 중인 상품이 ${usingCount}개 있습니다` });
  }
  
  db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// 상품의 brand/category 업데이트 (기존 상품에도 적용 가능)
router.patch('/products/:id/classify', (req, res) => {
  const { brand, product_category } = req.body;
  const db = getDb();
  try {
    const updates = [];
    const params = [];
    if (brand !== undefined) { updates.push('brand = ?'); params.push(brand || null); }
    if (product_category !== undefined) { updates.push('product_category = ?'); params.push(product_category || null); }
    if (!updates.length) return res.status(400).json({ error: '변경 항목 없음' });
    params.push(req.params.id);
    
    const result = db.prepare(`UPDATE products SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    if (!result.changes) return res.status(404).json({ error: '상품 없음' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
