# ── Stage 1: Install production dependencies ──────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

# ── Stage 2: Final runtime image ──────────────────────────────────────────────
FROM node:20-alpine

# Set timezone so cron schedules resolve correctly as a fallback
ENV TZ=Europe/London
ENV NODE_ENV=production

WORKDIR /app

# Copy deps from build stage (keeps image lean)
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY index.js ./
COPY package.json ./
COPY monthly-costs.html ./

# Run as non-root for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

CMD ["node", "index.js"]
