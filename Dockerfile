FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./

RUN npm install --omit=dev --build-from-source || npm install --omit=dev

COPY . .

RUN mkdir -p /data && chmod 777 /data

EXPOSE 8080

CMD ["node", "server.js"]
