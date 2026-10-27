# GoMoxie API — one image with Node, the built app and Chromium (PDFs and
# template previews). Built and run by Render (see render.yaml); also runs
# anywhere Docker does:  docker build -t gomoxie-api . && docker run --env-file .env -p 8000:8000 gomoxie-api
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    # Chromium is downloaded into the image, next to the app, by puppeteer's install step.
    PUPPETEER_CACHE_DIR=/app/.cache/puppeteer \
    CHROME_NO_SANDBOX=true

# Dependencies first (cached between builds while package*.json don't change).
# Dev dependencies stay: the build needs TypeScript, and start-up runs `prisma migrate deploy`.
COPY package.json package-lock.json ./
RUN npm ci --include=dev \
 # The system libraries Chromium needs, and basic fonts for any text a template font doesn't cover.
 && npx puppeteer browsers install chrome --install-deps \
 && apt-get update && apt-get install -y --no-install-recommends fonts-liberation fonts-noto-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY . .
# prisma.config.ts reads DATABASE_URL; generating the client doesn't connect, so a placeholder will do.
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" npx prisma generate \
 && npm run build

EXPOSE 8000
# Apply any new migrations (never resets anything), then start.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
