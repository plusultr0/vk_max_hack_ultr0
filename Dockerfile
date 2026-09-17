FROM node:22-alpine
WORKDIR /app

COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/bot/package.json apps/bot/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/llm/package.json packages/llm/package.json
COPY packages/max/package.json packages/max/package.json
COPY packages/ingestion/package.json packages/ingestion/package.json

RUN npm install --no-audit --no-fund
COPY . .
