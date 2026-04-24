# Playwright 공식 이미지 사용 (Chromium + 의존성 모두 포함)
FROM mcr.microsoft.com/playwright:v1.42.1-jammy

WORKDIR /app

# package.json 먼저 복사 (레이어 캐싱)
COPY package*.json ./

# 의존성 설치
RUN npm ci --omit=dev || npm install --omit=dev

# 소스 코드 복사
COPY . .

# 데이터 디렉토리 생성
RUN mkdir -p /data && chmod 777 /data

# 포트 노출 (Railway가 PORT env로 주입)
EXPOSE 3000

# 시작 명령
CMD ["node", "server.js"]
