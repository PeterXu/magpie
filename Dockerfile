# Chromium-only slim build. PLAYWRIGHT_BROWSERS_PATH=/ms-playwright keeps the
# browser world-readable so the non-root `node` user can exec it. Keep the
# playwright npm version (package-lock.json) in sync with what
# `npx playwright install` downloads.
FROM node:22-bookworm-slim
WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package.json package-lock.json ./
RUN npm ci \
 && npx playwright install --with-deps chromium \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/*
COPY --chown=node:node src ./src
ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1 \
    MAGPIE_NO_SANDBOX=1 \
    HOST=0.0.0.0 \
    PORT=8080
EXPOSE 8080
USER node
CMD ["node", "src/index.js"]
