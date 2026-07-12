FROM node:jod-alpine3.23 AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm test
RUN npm run build

FROM node:jod-alpine3.23 AS prod-deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:jod-alpine3.23 AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    SYNC_DB_DIR=/data

COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./package.json
COPY server ./server
COPY shared ./shared
COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh ./docker-entrypoint.sh

RUN apk add --no-cache su-exec \
  && chmod +x ./docker-entrypoint.sh \
  && mkdir -p /data && chown node:node /data

VOLUME ["/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/health" || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server/sync-server.mjs"]
