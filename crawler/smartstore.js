const { chromium } = require('playwright');
const { getDb } = require('../db');
const { takeSnapshot } = require('./search');

/**
 * Crawl product reviews from Naver SmartStore
 * - Robust error handling with full stack traces in logs
 * - Multi-selector strategy (네이버 DOM이 자주 바뀜)
 * - iframe support
 */
async function crawlProductReviews(product) {
  const db = getDb();
  let browser = null;
  let context = null;
  let newReviewCount = 0;
  let totalFound = 0;

  console.log(`\n🚀 [${product.name}] 리뷰 크롤링 시작 - URL: ${product.url}`);

  try {
    // 1. Launch browser with robust options
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        '--disable-dev-shm-usage', 
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--disable-web-security'
      ],
      timeout: 30000
    });
    console.log(`   ✓ Browser launched`);

    context = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      locale: 'ko-KR',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      extraHTTPHeaders: { 
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      }
    });

    const page = await context.newPage();
    
    // 2. Navigate to product page
    console.log(`   → Navigating to product page...`);
    try {
      await page.goto(product.url, { 
        waitUntil: 'domcontentloaded',
        timeout: 30000 
      });
      console.log(`   ✓ Page loaded`);
    } catch (navError) {
      console.error(`   ❌ Navigation failed: ${navError.message}`);
      throw new Error(`페이지 로드 실패: ${navError.message}`);
    }

    // Wait for dynamic content
    await page.waitForTimeout(3000);

    // 3. Get store name if not set
    if (!product.store_name) {
      try {
        const storeName = await page.locator(
          '[class*="seller_name"], [class*="Seller"], a[data-shp-area-id*="sellerinfo"]'
        ).first().textContent({ timeout: 3000 });
        
        if (storeName && storeName.trim()) {
          db.prepare(`UPDATE products SET store_name = ? WHERE id = ?`)
            .run(storeName.trim().substring(0, 100), product.id);
          console.log(`   ✓ Store name updated: ${storeName.trim()}`);
        }
      } catch (e) {
        console.log(`   ⚠ Could not get store name (continuing)`);
      }
    }

    // 4. Scroll to review section
    console.log(`   → Looking for review section...`);
    try {
      // Scroll down to trigger lazy loading
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight / 3);
      });
      await page.waitForTimeout(1500);
      
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight / 2);
      });
      await page.waitForTimeout(1500);
    } catch (e) {}

    // 5. Click review tab (try multiple selectors)
    let reviewTabClicked = false;
    const reviewTabSelectors = [
      'a[href="#REVIEW"]',
      'a[data-shp-area-id*="revtab"]',
      '[class*="tab"] >> text=리뷰',
      '[role="tab"]:has-text("리뷰")',
      'button:has-text("리뷰")',
      'a:has-text("리뷰")',
      'text=리뷰',
      'text=구매평',
    ];

    for (const selector of reviewTabSelectors) {
      try {
        const el = await page.locator(selector).first();
        if (await el.isVisible({ timeout: 2000 })) {
          await el.click({ timeout: 3000 });
          console.log(`   ✓ Review tab clicked: ${selector}`);
          reviewTabClicked = true;
          await page.waitForTimeout(3000);
          break;
        }
      } catch (e) {
        // Try next selector
      }
    }

    if (!reviewTabClicked) {
      console.log(`   ⚠ Review tab not found, continuing anyway (may be already visible)`);
    }

    // 6. Scroll to review list
    await page.evaluate(() => {
      const reviewSection = document.querySelector('[id*="REVIEW"], [class*="review_section"], [class*="ReviewList"]');
      if (reviewSection) reviewSection.scrollIntoView({ behavior: 'instant', block: 'start' });
    });
    await page.waitForTimeout(2000);

    // 7. Extract reviews - Multi-strategy approach
    console.log(`   → Extracting reviews...`);
    const reviews = await page.evaluate(() => {
      const results = [];
      const seenIds = new Set();
      
      // Try multiple container selectors (네이버 DOM 버전별)
      const containerSelectors = [
        'li[class*="BuyerReviewList_item"]',
        'li[class*="ReviewList_item"]',
        'li[class*="review_item"]',
        'div[class*="ReviewItem"]',
        'ul[class*="review"] > li',
        'div[class*="reviewItem"]',
        '[class*="_review"]',
        'li._1McwS6rnBJ',
        'li._2McITn-Da3',
        '.review_list_item',
      ];

      let reviewItems = [];
      let usedSelector = '';
      
      for (const sel of containerSelectors) {
        const items = document.querySelectorAll(sel);
        if (items.length > 0) {
          reviewItems = items;
          usedSelector = sel;
          break;
        }
      }

      if (reviewItems.length === 0) {
        // Last resort: find anything that looks like a review
        reviewItems = document.querySelectorAll('[class*="review"]:has(span), [class*="Review"]:has(span)');
      }

      // Capture context for debugging
      window.__DEBUG_SELECTOR = usedSelector;
      window.__DEBUG_COUNT = reviewItems.length;

      reviewItems.forEach((item, idx) => {
        try {
          const itemText = item.textContent || '';
          
          // Skip if too small (probably not a review)
          if (itemText.length < 20) return;

          // Rating - look for stars or numeric rating
          let rating = null;
          const ratingSelectors = [
            '[class*="rating"] em',
            '[class*="star"] em',
            '[class*="Rating"]',
            '[aria-label*="별점"]',
            '[aria-label*="점"]',
            'em[class*="grade"]',
          ];
          
          for (const rs of ratingSelectors) {
            const re = item.querySelector(rs);
            if (re) {
              const rt = (re.textContent || re.getAttribute('aria-label') || '').trim();
              const m = rt.match(/([1-5])/);
              if (m) {
                rating = parseInt(m[1]);
                break;
              }
            }
          }
          
          // Fallback: count star icons
          if (!rating) {
            const filledStars = item.querySelectorAll('[class*="star"][class*="fill"], [class*="star"][class*="active"]').length;
            if (filledStars > 0 && filledStars <= 5) rating = filledStars;
          }

          // Content
          let content = '';
          const contentSelectors = [
            '[class*="reviewText"]',
            '[class*="review_text"]',
            '[class*="ReviewText"]',
            'p[class*="text"]',
            'span[class*="text"]',
            '[class*="content"]',
          ];
          
          for (const cs of contentSelectors) {
            const ce = item.querySelector(cs);
            if (ce && ce.textContent && ce.textContent.trim().length > 10) {
              content = ce.textContent.trim();
              break;
            }
          }

          // Fallback: find longest text in item
          if (!content) {
            let longest = '';
            item.querySelectorAll('p, span, div').forEach(el => {
              const t = (el.textContent || '').trim();
              if (t.length > longest.length && t.length < 2000 && el.children.length === 0) {
                longest = t;
              }
            });
            content = longest;
          }

          // Author
          let author = '';
          const authorSelectors = [
            '[class*="reviewer"]',
            '[class*="writer"]',
            '[class*="userName"]',
            '[class*="author"]',
            'strong[class*="name"]',
          ];
          
          for (const as of authorSelectors) {
            const ae = item.querySelector(as);
            if (ae && ae.textContent) {
              author = ae.textContent.trim().substring(0, 30);
              break;
            }
          }

          // Date
          let date = '';
          const dateSelectors = [
            'time',
            '[class*="date"]',
            '[class*="Date"]',
            'em[class*="time"]',
          ];
          
          for (const ds of dateSelectors) {
            const de = item.querySelector(ds);
            if (de && de.textContent) {
              date = de.textContent.trim().substring(0, 30);
              break;
            }
          }

          // Option
          let option = '';
          const optionEl = item.querySelector('[class*="option"], [class*="Option"]');
          if (optionEl) option = optionEl.textContent.trim().substring(0, 100);

          // Helpful count
          let helpful = 0;
          const helpfulEl = item.querySelector('[class*="helpful"], [class*="like"], [class*="thumb"]');
          if (helpfulEl) {
            const m = helpfulEl.textContent.match(/\d+/);
            if (m) helpful = parseInt(m[0]);
          }

          // Has photo
          const hasPhoto = !!item.querySelector('img[src*="review"], [class*="photo"], [class*="image"]:not([class*="user"]):not([class*="profile"])');

          // Review ID
          const reviewId = item.getAttribute('data-review-id') || 
                          item.getAttribute('data-id') ||
                          item.id || 
                          `${idx}_${(content || '').substring(0, 30)}`;
          
          if (seenIds.has(reviewId)) return;
          seenIds.add(reviewId);

          if (content || rating) {
            results.push({ reviewId, rating, content, author, date, option, helpful, hasPhoto });
          }
        } catch (e) {
          // Skip problematic item
        }
      });

      return {
        reviews: results,
        debugSelector: usedSelector,
        debugCount: reviewItems.length,
        pageTitle: document.title,
        url: location.href
      };
    });

    const reviewData = reviews;
    console.log(`   📊 Debug: selector="${reviewData.debugSelector}", items found=${reviewData.debugCount}, parsed=${reviewData.reviews.length}`);
    console.log(`   📊 Page title: ${reviewData.pageTitle}`);

    totalFound = reviewData.reviews.length;

    // 8. Save reviews to DB
    if (totalFound > 0) {
      const insertReview = db.prepare(`
        INSERT OR IGNORE INTO reviews 
        (product_id, review_id, author, rating, content, option_info, helpful_count, has_photo, review_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertMany = db.transaction((reviewList) => {
        for (const r of reviewList) {
          const result = insertReview.run(
            product.id, 
            r.reviewId, 
            r.author || '', 
            r.rating || null, 
            r.content || '', 
            r.option || '', 
            r.helpful || 0, 
            r.hasPhoto ? 1 : 0, 
            r.date || ''
          );
          if (result.changes > 0) newReviewCount++;
        }
      });

      insertMany(reviewData.reviews);
    }

    // 9. Update timestamps
    db.prepare(`UPDATE products SET last_crawled_at = datetime('now','localtime') WHERE id = ?`).run(product.id);
    
    db.prepare(`INSERT INTO crawl_logs (product_id, crawl_type, status, reviews_found, new_reviews) VALUES (?, 'reviews', ?, ?, ?)`)
      .run(product.id, totalFound > 0 ? 'success' : 'no_data', totalFound, newReviewCount);

    console.log(`✅ [${product.name}] 리뷰 ${totalFound}개 수집, ${newReviewCount}개 신규\n`);
    return { success: true, totalFound, newReviewCount };

  } catch (error) {
    // CRITICAL: Always log errors with full details
    console.error(`\n❌❌❌ [${product.name}] 리뷰 크롤링 실패 ❌❌❌`);
    console.error(`   Error Type: ${error.name}`);
    console.error(`   Message: ${error.message}`);
    console.error(`   Stack: ${(error.stack || '').split('\n').slice(0, 5).join('\n   ')}`);
    console.error();
    
    try {
      db.prepare(`INSERT INTO crawl_logs (product_id, crawl_type, status, error_message) VALUES (?, 'reviews', 'error', ?)`)
        .run(product.id, `${error.name}: ${error.message}`.substring(0, 500));
    } catch (dbErr) {
      console.error(`   DB log insert also failed: ${dbErr.message}`);
    }
    
    return { success: false, error: error.message, errorType: error.name };
  } finally {
    try { if (context) await context.close(); } catch (e) {}
    try { if (browser) await browser.close(); } catch (e) {}
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
    console.error(`❌ 스냅샷 실패: ${e.message}`);
    try {
      db.prepare(`INSERT INTO crawl_logs (product_id, crawl_type, status, error_message) VALUES (?, 'snapshot', 'error', ?)`)
        .run(product.id, (e.message || '').substring(0, 500));
    } catch (dbErr) {}
    return { success: false, error: e.message };
  }
}

async function crawlAllProducts() {
  const db = getDb();
  const products = db.prepare('SELECT * FROM products WHERE active = 1').all();
  console.log(`\n🔍 ${products.length}개 상품 수집 시작\n`);
  
  const results = [];
  for (const product of products) {
    let snapResult = null;
    let revResult = null;
    
    try {
      snapResult = await takeProductSnapshot(product);
    } catch (e) {
      console.error(`스냅샷 예외: ${e.message}`);
      snapResult = { success: false, error: e.message };
    }
    
    await new Promise(r => setTimeout(r, 2000));
    
    try {
      revResult = await crawlProductReviews(product);
    } catch (e) {
      console.error(`리뷰 크롤링 예외 (최상위): ${e.message}`);
      revResult = { success: false, error: e.message };
    }
    
    results.push({ product: product.name, snapshot: snapResult, reviews: revResult });
    await new Promise(r => setTimeout(r, 3000));
  }
  
  console.log(`\n✅ 전체 수집 완료\n`);
  return results;
}

module.exports = { crawlProductReviews, crawlAllProducts, takeProductSnapshot };
