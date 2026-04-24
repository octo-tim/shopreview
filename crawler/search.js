const { chromium } = require('playwright');

/**
 * Search Naver Shopping using Official API
 */
async function searchNaverShopping(keyword, limit = 40) {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('네이버 API 키가 설정되지 않았습니다. Railway 환경변수에 NAVER_CLIENT_ID, NAVER_CLIENT_SECRET을 추가하세요.');
  }

  const display = Math.min(limit, 100);
  const url = `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(keyword)}&display=${display}&sort=sim`;

  console.log(`🔍 네이버 API 호출: ${keyword} (limit=${display})`);

  try {
    const response = await fetch(url, {
      headers: {
        'X-Naver-Client-Id': clientId,
        'X-Naver-Client-Secret': clientSecret,
      }
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`네이버 API 응답 실패 (${response.status}): ${text}`);
      throw new Error(`네이버 API 오류 (${response.status}): ${text}`);
    }

    const data = await response.json();
    console.log(`📦 네이버 API 응답: total=${data.total}, items=${data.items?.length || 0}`);

    if (!data.items || data.items.length === 0) {
      console.log(`⚠️ 검색 결과 없음: ${keyword}`);
      return [];
    }

    const products = data.items.map((item, idx) => {
      const title = (item.title || '').replace(/<\/?b>/g, '').replace(/<[^>]+>/g, '');
      
      let productCode = '';
      const codeMatch = (item.link || '').match(/products\/(\d+)/) || 
                       (item.link || '').match(/\/(\d{8,})/);
      if (codeMatch) productCode = codeMatch[1];

      const price = item.lprice ? parseInt(item.lprice) : null;
      const highPrice = item.hprice ? parseInt(item.hprice) : null;

      return {
        rank: idx + 1,
        isAd: false,
        title,
        url: item.link || '',
        imageUrl: item.image || '',
        price,
        originalPrice: highPrice && highPrice > price ? highPrice : null,
        mallName: item.mallName || '',
        rating: null,
        reviewCount: 0,
        category: [item.category1, item.category2, item.category3, item.category4].filter(Boolean).join(' > '),
        productCode,
        brand: item.brand || '',
        maker: item.maker || '',
        productId: item.productId || ''
      };
    });

    console.log(`✅ 네이버 API [${keyword}] ${products.length}개 상품 반환`);
    return products;

  } catch (error) {
    console.error(`❌ 네이버 API 검색 실패 [${keyword}]:`, error.message);
    throw error;
  }
}

async function takeSnapshot(product) {
  if (!product.tracking_keyword) {
    return { success: false, error: '추적 키워드가 설정되지 않았습니다' };
  }

  try {
    const results = await searchNaverShopping(product.tracking_keyword, 100);
    
    let matched = null;
    results.forEach(r => {
      const sameUrl = r.url && product.url && (
        r.url === product.url || 
        r.url.includes(product.url.split('?')[0]) ||
        product.url.includes(r.url.split('?')[0])
      );
      const sameCode = product.product_code && r.productCode === product.product_code;
      
      if (sameUrl || sameCode) matched = r;
    });

    let reviewData = { reviewCount: null, rating: null };
    if (matched) {
      try {
        reviewData = await quickCrawlReviewStats(matched.url);
      } catch (e) {}
    }

    return {
      success: true,
      found: !!matched,
      rank: matched?.rank || null,
      isAd: 0,
      price: matched?.price || null,
      originalPrice: matched?.originalPrice || null,
      reviewCount: reviewData.reviewCount,
      rating: reviewData.rating,
      totalResults: results.length
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function quickCrawlReviewStats(productUrl) {
  let browser = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0',
      locale: 'ko-KR'
    });
    const page = await ctx.newPage();
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1500);

    const stats = await page.evaluate(() => {
      const ratingText = document.body.textContent.match(/(\d+\.\d+)\s*(?:\/\s*5|점)/);
      const rating = ratingText ? parseFloat(ratingText[1]) : null;
      const reviewMatch = document.body.textContent.match(/리뷰\s*\(?(\d[\d,]*)/);
      const reviewCount = reviewMatch ? parseInt(reviewMatch[1].replace(/,/g, '')) : null;
      return { rating, reviewCount };
    });

    return stats;
  } catch (e) {
    return { reviewCount: null, rating: null };
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { searchNaverShopping, takeSnapshot };
