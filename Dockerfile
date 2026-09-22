# Секреты приходят снаружи: --env-file или -e. В образ их не копировать.
# Миграции отдельно от процесса:
#   docker run --rm --env-file .env tg-progress-bot node dist/scripts/migrate.js
# Процесс:
#   docker run --rm --env-file .env -p 8080:8080 tg-progress-bot

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npx tsc -p tsconfig.build.json

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
USER node
EXPOSE 8080
CMD ["node", "dist/src/index.js"]
