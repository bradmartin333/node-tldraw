FROM node:jod-alpine3.23 AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
# Gate the image on the unit tests: the published image (see
# .github/workflows/docker-publish.yml) is built from this stage, so a failing
# test fails the build rather than shipping.
RUN npm test
RUN npm run build

FROM node:jod-alpine3.23 AS runtime

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/vite.config.js ./vite.config.js
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/dist ./dist

EXPOSE 3000

CMD ["npm", "run", "preview"]
