require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
const { crawlAllProducts } = require('./crawler/smartstore');
const apiRouter = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api', apiRouter);

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Cron: crawl every 30 minutes ───────────────────
cron.schedule('*/30 * * * *', async () => {
  console.log(`\n⏰ [${new Date().toLocaleString('ko-KR')}] 자동 크롤링 시작`);
  try {
    await crawlAllProducts();
  } catch (e) {
    console.error('자동 크롤링 오류:', e.message);
  }
});

app.listen(PORT, () => {
  console.log(`
🚀 리뷰 모니터링 서버 시작
   포트: ${PORT}
   크롤링 주기: 30분마다 자동 실행
   DB: ${process.env.DB_PATH || './data/reviews.db'}
  `);
});
