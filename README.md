# 🔍 리뷰 레이더 v2 — 키워드 기반 경쟁 상품 모니터링

네이버 스마트스토어에서 키워드로 경쟁 상품을 검색하고, 관심 상품의 리뷰·순위·가격·별점 추이를 자동 추적하는 시스템

## ✨ 주요 기능

### 1. 🔎 키워드 검색
- 네이버쇼핑 상위 40개 상품 노출 순위대로 리스팅
- 광고/일반 구분, 썸네일, 가격, 별점, 리뷰수, 스토어명 표시
- 클릭 한 번으로 트래킹 시작

### 2. 📈 추이 분석 (4가지 지표)
- **검색 순위**: 지정 키워드에서의 노출 순위 변동
- **판매가**: 가격 변동 추이
- **리뷰 수**: 누적 리뷰 증가 추이
- **별점**: 평점 변동

### 3. 💬 리뷰 수집 & AI 분석
- 각 트래킹 상품의 리뷰 자동 수집
- 5가지 AI 분석: 종합 요약 / 불만 패턴 / 강점 / 시장 기회 / 경쟁 인사이트

### 4. ⏰ 자동 수집
- **30분마다** 모든 트래킹 상품에 대해:
  - 키워드 검색 → 현재 순위 스냅샷
  - 현재 가격, 리뷰 수, 별점 스냅샷
  - 새로운 리뷰 크롤링

## 🛠 기술 스택
- Node.js + Express
- SQLite (better-sqlite3)
- Playwright (크롤링)
- Chart.js (추이 그래프)
- Claude AI API (리뷰 분석)

## 🚀 로컬 실행

```bash
npm install
npx playwright install chromium
cp .env.example .env
npm start
```

브라우저에서 `http://localhost:3000` 접속

## ☁️ Railway 배포

1. GitHub에 push
2. Railway → New Project → GitHub 연결
3. Volume 추가: Mount Path = `/data`
4. Environment Variable: `DB_PATH=/data/reviews.db`
5. Deploy (railway.toml이 Playwright 자동 설치)

## 📁 프로젝트 구조

```
review-monitor-v2/
├── server.js          # Express + 30분 크론
├── db.js              # SQLite 스키마 (v2: snapshots 테이블 추가)
├── crawler/
│   ├── search.js      # 네이버쇼핑 키워드 검색
│   └── smartstore.js  # 리뷰 크롤링 + 스냅샷
├── routes/
│   └── api.js         # REST API
├── public/
│   └── index.html     # 대시보드 UI (Chart.js 추이 그래프)
└── railway.toml
```

## ⚠️ 주의사항

- **네이버 이용약관상 자동화 크롤링 제한**이 있어 내부 리서치 용도로만 사용
- 30분 간격 자동 수집 → 과도한 요청 방지 (더 자주 하면 IP 차단 위험)
- 네이버쇼핑/스마트스토어 UI 변경 시 크롤러 셀렉터 조정 필요할 수 있음

## 📊 API 엔드포인트

### 검색
- `POST /api/search` { keyword, limit } — 네이버쇼핑 검색
- `GET /api/search-history` — 최근 검색어

### 상품
- `GET /api/products` — 트래킹 상품 목록
- `POST /api/products` — 상품 트래킹 시작
- `DELETE /api/products/:id` — 트래킹 중단
- `POST /api/products/:id/crawl` — 즉시 수집
- `POST /api/products/:id/snapshot` — 스냅샷만 기록

### 추이
- `GET /api/products/:id/snapshots` — 전체 스냅샷 (시계열)
- `GET /api/products/:id/trends` — 추이 요약

### 리뷰
- `GET /api/products/:id/reviews` — 상품별 리뷰
- `GET /api/products/:id/stats` — 리뷰 통계 (별점 분포, 키워드)
- `GET /api/reviews` — 전체 리뷰

### AI
- `GET /api/products/:id/analyses` — 저장된 AI 분석
- `POST /api/products/:id/analyses` — AI 분석 저장
