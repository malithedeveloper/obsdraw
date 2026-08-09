FROM node:22-alpine AS build

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    npm_config_libc=musl

COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit

COPY . .
RUN npm run build

FROM build AS production-dependencies
RUN npm prune --omit=dev --no-fund --no-audit \
  && find node_modules/@next -mindepth 1 -maxdepth 1 -type d -name '*-gnu' -exec rm -rf -- {} + \
  && find node_modules/@img -mindepth 1 -maxdepth 1 -type d \( -name 'sharp-linux-*' -o -name 'sharp-libvips-linux-*' -o -name 'sharp-wasm32' \) -exec rm -rf -- {} +

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOST=0.0.0.0 \
    PORT=3000 \
    LOCAL_STORE_DIR=/app/server-data

COPY --chown=node:node --from=production-dependencies /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/.next ./.next
COPY --chown=node:node --from=build /app/public ./public
COPY --chown=node:node --from=build /app/src/lib/*.mjs ./src/lib/
COPY --chown=node:node --from=build /app/src/server ./src/server
COPY --chown=node:node --from=build /app/server.mjs /app/next.config.mjs /app/package.json ./

RUN mkdir -p /app/server-data/boards && chown node:node /app/server-data /app/server-data/boards
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1

CMD ["npm", "start"]
