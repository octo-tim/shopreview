// 기존 리뷰의 quality_score를 룰 기반으로 일괄 계산
require('dotenv').config();
const { getDb } = require('../db');

function calculateQualityScore(review) {
  let score = 50;
  const flags = [];
  const text = (review.content || '').trim();
  const len = text.length;
  
  if (review.rating === 5) score += 20;
  else if (review.rating === 4) score += 10;
  else if (review.rating === 3) { score -= 5; flags.push('mid_rating'); }
  else if (review.rating === 2) { score -= 15; flags.push('low_rating'); }
  else if (review.rating === 1) { score -= 30; flags.push('very_low_rating'); }
  
  if (len >= 200) score += 15;
  else if (len >= 100) score += 10;
  else if (len >= 50) score += 5;
  else if (len < 30) { score -= 10; flags.push('too_short'); }
  
  if (review.has_photo) score += 5;
  
  const positiveKeywords = ['좋아요', '만족', '추천', '최고', '훌륭', '대박', '예뻐', '예쁘', '편해', '편리', '튼튼', '깔끔', '굿', '잘쓰', '잘써'];
  const positiveCount = positiveKeywords.filter(k => text.includes(k)).length;
  if (positiveCount >= 1) score += Math.min(positiveCount * 5, 10);
  
  const negativeKeywords = ['고장', '환불', '별로', '실망', '불량', '최악', '안좋', '안 좋', '하자', '파손', '냄새', '이상함', '아쉬', '교환'];
  const negativeFound = negativeKeywords.filter(k => text.includes(k));
  if (negativeFound.length > 0) {
    score -= negativeFound.length * 10;
    flags.push('negative:' + negativeFound.join(','));
  }
  
  if (len > 5) {
    const compactText = text.replace(/\s/g, '');
    const unique = new Set(compactText.split('')).size;
    const ratio = unique / compactText.length;
    if (ratio < 0.3) { score -= 10; flags.push('repetitive'); }
  }
  
  const koreanChars = (text.match(/[\uAC00-\uD7AF]/g) || []).length;
  if (len > 10 && koreanChars / len < 0.3) {
    score -= 5;
    flags.push('low_text_density');
  }
  
  score = Math.max(0, Math.min(100, score));
  return { quality_score: score, quality_flags: flags.length > 0 ? flags.join('|') : null };
}

const db = getDb();
const reviews = db.prepare('SELECT id, content, rating, has_photo FROM reviews WHERE quality_score IS NULL').all();
console.log(`📊 소급 계산 대상: ${reviews.length}개`);

const update = db.prepare('UPDATE reviews SET quality_score = ?, quality_flags = ? WHERE id = ?');
const tx = db.transaction(() => {
  let count = 0;
  const dist = { excellent: 0, good: 0, normal: 0, warn: 0, bad: 0 };
  
  for (const r of reviews) {
    const q = calculateQualityScore(r);
    update.run(q.quality_score, q.quality_flags, r.id);
    count++;
    
    if (q.quality_score >= 80) dist.excellent++;
    else if (q.quality_score >= 65) dist.good++;
    else if (q.quality_score >= 45) dist.normal++;
    else if (q.quality_score >= 25) dist.warn++;
    else dist.bad++;
  }
  
  console.log(`✅ ${count}개 업데이트 완료`);
  console.log(`   우수(80+): ${dist.excellent}, 양호(65-79): ${dist.good}, 보통(45-64): ${dist.normal}, 주의(25-44): ${dist.warn}, 나쁨(<25): ${dist.bad}`);
});
tx();
process.exit(0);
