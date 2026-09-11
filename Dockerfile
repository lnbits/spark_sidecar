FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    SPARK_SIDECAR_HOST=0.0.0.0 \
    SPARK_SIDECAR_PORT=8765

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev && npm cache clean --force

COPY server.mjs payments.mjs lightning.mjs incoming.mjs operation-queue.mjs ./

RUN chown -R node:node /app

USER node

EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.SPARK_SIDECAR_PORT || 8765}/health`, {headers: {'x-api-key': process.env.SPARK_SIDECAR_API_KEY || ''}}).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "server.mjs"]
