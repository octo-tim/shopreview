FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /data && chmod 777 /data

EXPOSE 8080

CMD ["node", "server.js"]
