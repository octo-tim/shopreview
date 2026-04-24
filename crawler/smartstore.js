const { chromium } = require('playwright');
const { getDb } = require('../db');
const { takeSnapshot } = require('./search');

async function crawlProductReviews(product) {
  const db = getDb();
  let browser = null;
  let newReviewCount = 0;
  let totalFound = 0;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'ko-KR',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      extraHTTPHeaders: { 'Accept-Language': 'ko-KR,ko;q=0.9' }
    });

    const page = await context.newPage();
    await page.goto(product.url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    try {
      await page.locator('text=구매평').first().click();
      await page.waitForTimeout(2000);
    } catch (e) {
      try { await page.click('[data-nclick*="review"]'); await page.waitForTimeout(2000); } catch (e2) {}
    }

    if (!product.store_name) {
      try {
        const storeName = await page.locator('.productSellerInfo_seller_name__pq5Li, ._2-I30XS1lA').first().textContent();
        if (storeName) db.prepare('UPDATE products SET store_name = ? WHERE id = ?').run(storeName.trim(), product.id);
      } catch (e) {}
    }

    const reviews = [];
    let pageNum = 1;
    const maxPages = 5;

    while (pageNum <= maxPages) {
      await page.waitForTimeout(1500);

      const pageReviews = await page.evaluate(() => {
        const reviewItems = document.querySelectorAll('._2McITn-Da3, .review_list_item, [class*="reviewItem"], ._3HGpzaHO3L');
        const results = [];
        
        reviewItems.forEach((item, idx) => {
          try {
            const ratingEl = item.querySelector('[class*="rating"], [class*="star"], ._15jtJqAIeQ');
            const ratingText = ratingEl ? (ratingEl.textContent || ratingEl.getAttribute('aria-label') || '') : '';
            const ratingMatch = ratingText.match(/(\d+)/);
            const rating = ratingMatch ? parseInt(ratingMatch[1]) : null;

            const contentEl = item.querySelector('[class*="reviewText"], [class*="review_content"], ._3HGpzaHO3L, ._2WG8tL44Y8');
            const content = contentEl ? contentEl.textContent.trim() : '';

            const authorEl = item.querySelector('[class*="reviewer"], [class*="author"], ._2FJVN-9Sch');
            const author = authorEl ? authorEl.textContent.trim() : '';

            const dateEl = item.querySelector('[class*="date"], ._2FJVN-9Sch + span, time');
            const date = dateEl ? dateEl.textContent.trim() : '';

            const optionEl = item.querySelector('[class*="option"], ._2FXnPOabBZ');
            const option = optionEl ? optionEl.textContent.trim() : '';

            const helpfulEl = item.querySelector('[class*="helpful"], [class*="like"]');
            const helpfulText = helpfulEl ? helpfulEl.textContent.match(/\d+/) : null;
            const helpful = helpfulText ? parseInt(helpfulText[0]) : 0;

            const hasPhoto = !!item.querySelector('img[class*="review"], [class*="reviewImage"]');
            const reviewId = item.getAttribute('data-review-id') || item.id || `idx_${idx}_${Date.now()}`;

            if (content || rating) results.push({ reviewId, rating, content, author, date, option, helpful, hasPhoto });
          } catch (e) {}
        });
        return results;
      });

      if (pageReviews.length === 0) break;
      reviews.push(...pageReviews);
      totalFound += pageReviews.length;

      try {
        const nextBtn = await page.locator('[class*="pagination"] button:last-child, .pagination_next, ._2Ar8-aEUTq').last();
        const isDisabled = await nextBtn.getAttribute('disabled');
        if (isDisabled) break;
        await nextBtn.click();
        pageNum++;
      } catch (e) { break; }
    }

    const insertReview = db.prepare(`
      INSERT OR IGNORE INTO reviews (product_id, review_id, author, rating, content, option_info, helpful_count, has_photo, review_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((reviews) => {
      for (const r of reviews) {
        const result = insertReview.run(product.id, r.reviewId, r.author, r.rating, r.content, r.option, r.helpful, r.hasPhoto ? 1 : 0, r.date);
        if (result.changes > 0) newReviewCount++;
      }
    });

    insertMany(reviews);
    db.prepare('UPDATE products SET last_crawled_at = datetime("now","localtime") WHERE id = ?').run(product.id);
    db.prepare(`INSERT INTO crawl_logs (product_id, crawl_type, status, reviews_found, new_reviews) VALUES (?, 'reviews', 'success', ?, ?)`).run(product.id, totalFound, newReviewCount);

    console.log(`✅ [${product.name}] 리뷰 ${totalFound}개, ${newReviewCount}개 신규`);
    return { success: true, totalFound, newReviewCount };

  } catch (error) {
    console.error(`❌ [${product.name}] 리뷰 실패:`, error.message);
    db.prepare(`INSERT INTO crawl_logs (product_id, crawl_type, status, error_message) VALUES (?, 'reviews', 'error', ?)`).run(product.id, error.message);
    return { success: false, error: error.message };
  } finally {
    if (browser) await browser.close();
  }
}

async function takeProductSnapshot(product) {
  const db = getDb();
  if (!product.tracking_keyword) return { success: false, error: '추적 키워드 없음' };

  try {
    const snap = await takeSnapshot(product);
    
    if (snap.success) {
      db.prepare(`INSERT INTO snapshots (product_id, keyword, search_rank, is_ad, price, original_price, review_count, rating) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(product.id, product.tracking_keyword, snap.rank, snap.isAd, snap.price, snap.originalPrice, snap.reviewCount, snap.rating);

      db.prepare(`INSERT INTO crawl_logs (product_id, crawl_type, status) VALUES (?, 'snapshot', ?)`)
        .run(product.id, snap.found ? 'success' : 'not_found');

      console.log(`📸 [${product.name}] 순위:${snap.rank||'–'} 가격:${snap.price||'–'} 리뷰:${snap.reviewCount||'–'}`);
    }
    return snap;
  } catch (e) {
    db.prepare(`INSERT INTO crawl_logs (product_id, crawl_type, status, error_message) VALUES (?, 'snapshot', 'error', ?)`).run(product.id, e.message);
    return { success: false, error: e.message };
  }
}

async function crawlAllProducts() {
  const db = getDb();
  const products = db.prepare('SELECT * FROM products WHERE active = 1').all();
  console.log(`🔍 ${products.length}개 상품 수집 시작`);
  
  const results = [];
  for (const product of products) {
    const snapResult = await takeProductSnapshot(product);
    await new Promise(r => setTimeout(r, 2000));
    const revResult = await crawlProductReviews(product);
    results.push({ product: product.name, snapshot: snapResult, reviews: revResult });
    await new Promise(r => setTimeout(r, 3000));
  }
  return results;
}

module.exports = { crawlProductReviews, crawlAllProducts, takeProductSnapshot };
