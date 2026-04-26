require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists BEFORE any DB access
const dataDir = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log(`✓ Data directory created: ${dataDir}`);
  } catch (e) {
    console.error(`✗ Failed to create data dir: ${e.message}`);
    // Fall back to local dir
    process.env.DB_PATH = path.join(__dirname, 'data', 'reviews.db');
    fs.mkdirSync(path.dirname(process.env.DB_PATH), { recursive: true });
  }
}

const { crawlAllProducts } = require('./crawler/smartstore');
const apiRouter = require('./routes/api');
const { getDb } = require('./db');

// Initialize DB early to catch errors
try {
  getDb();
  console.log('✓ Database initialized');
} catch (e) {
  console.error('✗ Database init failed:', e.message);
  process.exit(1);
}

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = '0.0.0.0';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api', apiRouter);

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Express error:', err);
  res.status(500).json({ error: err.message });
});

// Cron: crawl every 30 minutes
cron.schedule('*/30 * * * *', async () => {
  console.log(`\n⏰ [${new Date().toLocaleString('ko-KR')}] 자동 크롤링 시작`);
  try {
    await crawlAllProducts();
  } catch (e) {
    console.error('자동 크롤링 오류:', e.message);
  }
});

app.listen(PORT, HOST, () => {
  console.log(`
🚀 리뷰 레이더 서버 시작
   주소: http://${HOST}:${PORT}
   DB: ${process.env.DB_PATH || path.join(__dirname, 'data/reviews.db')}
   크론: 30분마다 자동 수집
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => { console.log('SIGTERM 수신'); process.exit(0); });
process.on('uncaughtException', (e) => console.error('Uncaught:', e));
process.on('unhandledRejection', (e) => console.error('Unhandled:', e));
