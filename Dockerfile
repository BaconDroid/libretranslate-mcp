# Build: install dependencies, compile TypeScript, prune to runtime deps only.
# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
# `npm ci` when a lockfile is present, `npm install` otherwise.
RUN npm ci || npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY --from=build /app/dist ./dist
COPY entrypoint-mcp.sh ./entrypoint-mcp.sh
RUN chmod +x ./entrypoint-mcp.sh

ENV TRANSPORT=http \
    PORT=8787 \
    LIBRETRANSLATE_URL=http://libretranslate:5000

USER node
EXPOSE 8787
ENTRYPOINT ["/app/entrypoint-mcp.sh"]
