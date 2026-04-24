const { chromium } = require('playwright');

/**
 * Search Naver Shopping for a keyword and return top N products with ranking
 * @param {string} keyword - search keyword
 * @param {number} limit - max results (default 40)
 */
async function searchNaverShopping(keyword, limit = 40) {
  let browser = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ]
    });

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'ko-KR',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      extraHTTPHeaders: { 'Accept-Language': 'ko-KR,ko;q=0.9' }
    });

    const page = await context.newPage();
    const searchUrl = `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(keyword)}`;
    
    await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Scroll to load more results
    const scrollsNeeded = Math.ceil(limit / 10);
    for (let i = 0; i < scrollsNeeded; i++) {
      await page.evaluate(() => window.scrollBy(0, 1000));
      await page.waitForTimeout(800);
    }

    // Extract products
    const products = await page.evaluate((maxLimit) => {
      const items = document.querySelectorAll(
        '[class*="product_item"], [class*="basicList_item"], li[class*="item"]'
      );
      
      const results = [];
      let rank = 0;

      items.forEach((item, idx) => {
        if (results.length >= maxLimit) return;

        try {
          // Title and URL
          const linkEl = item.querySelector('a[class*="product_link"], a[class*="basicList_link"], a[href*="smartstore"], a[href*="shopping.naver"]');
          if (!linkEl) return;
          
          const title = linkEl.textContent?.trim() || 
                       item.querySelector('[class*="product_title"], [class*="basicList_title"]')?.textContent?.trim() || '';
          const url = linkEl.href || '';
          
          if (!title || !url) return;

          // Is ad
          const adBadge = item.querySelector('[class*="ad"], [class*="Ad"]');
          const isAd = !!adBadge && (adBadge.textContent || '').includes('광고');

          // Image
          const img = item.querySelector('img');
          const imageUrl = img?.src || img?.getAttribute('data-src') || '';

          // Price
          const priceEl = item.querySelector('[class*="price_num"], [class*="basicList_price"] .price_num, strong.price');
          const priceText = priceEl?.textContent?.replace(/[^\d]/g, '') || '';
          const price = priceText ? parseInt(priceText) : null;

          // Original price (if discounted)
          const origPriceEl = item.querySelector('[class*="price_original"], del');
          const origText = origPriceEl?.textContent?.replace(/[^\d]/g, '') || '';
          const originalPrice = origText ? parseInt(origText) : null;

          // Mall / store
          const mallEl = item.querySelector('[class*="mall_title"], [class*="basicList_mall"], a[class*="mall"]');
          const mallName = mallEl?.textContent?.trim() || '';

          // Rating
          const ratingEl = item.querySelector('[class*="rating"], em[class*="star"]');
          const ratingText = ratingEl?.textContent?.match(/[\d.]+/)?.[0] || '';
          const rating = ratingText ? parseFloat(ratingText) : null;

          // Review count
          const reviewEl = item.querySelector('[class*="review"], em[class*="review_count"]');
          const reviewText = reviewEl?.textContent?.match(/[\d,]+/)?.[0]?.replace(/,/g, '') || '';
          const reviewCount = reviewText ? parseInt(reviewText) : 0;

          // Category path
          const catEl = item.querySelector('[class*="category"], [class*="depth"]');
          const category = catEl?.textContent?.trim() || '';

          // Rank (non-ad items get sequential rank)
          if (!isAd) rank++;

          // Extract product code from URL
          let productCode = '';
          const codeMatch = url.match(/products\/(\d+)/) || url.match(/product\/(\d+)/) || url.match(/\/(\d{8,})/);
          if (codeMatch) productCode = codeMatch[1];

          results.push({
            rank: isAd ? null : rank,
            isAd,
            title,
            url,
            imageUrl,
            price,
            originalPrice,
            mallName,
            rating,
            reviewCount,
            category,
            productCode
          });
        } catch (e) {}
      });

      return results;
    }, limit);

    console.log(`🔎 [${keyword}] ${products.length}개 상품 수집`);
    return products;

  } catch (error) {
    console.error(`❌ 검색 실패 [${keyword}]:`, error.message);
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Get current snapshot (ranking + price + review count + rating) for tracked products
 */
async function takeSnapshot(product) {
  if (!product.tracking_keyword) {
    return { success: false, error: '추적 키워드가 설정되지 않았습니다' };
  }

  try {
    const results = await searchNaverShopping(product.tracking_keyword, 120);
    
    // Find matching product by URL or product code
    let matched = null;
    let currentRank = null;

    results.forEach(r => {
      const sameUrl = r.url && product.url && (
        r.url === product.url || 
        r.url.includes(product.url.split('?')[0]) ||
        product.url.includes(r.url.split('?')[0])
      );
      const sameCode = product.product_code && r.productCode === product.product_code;
      
      if (sameUrl || sameCode) {
        matched = r;
      }
    });

    return {
      success: true,
      found: !!matched,
      rank: matched?.rank || null,
      isAd: matched?.isAd ? 1 : 0,
      price: matched?.price || null,
      originalPrice: matched?.originalPrice || null,
      reviewCount: matched?.reviewCount || null,
      rating: matched?.rating || null,
      totalResults: results.length
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = { searchNaverShopping, takeSnapshot };
