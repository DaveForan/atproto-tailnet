# ---------------------------------------------------------------------------
# atproto-tailnet  --  multi-stage production build
# ---------------------------------------------------------------------------

# Base images are pinned by digest. To update: `docker buildx imagetools
# inspect node:22-alpine` and copy the new digest here.

# ---- build stage ---------------------------------------------------------
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS build

WORKDIR /app

# Install dependencies first (layer cache)
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Copy source and build
COPY tsconfig.json tsconfig.client.json esbuild.config.ts ./
COPY src/ src/
COPY public/css/ public/css/
RUN npm run build:client && npm run build

# ---- runtime stage -------------------------------------------------------
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a

RUN apk add --no-cache tini \
    && mkdir -p /app && chown node:node /app

WORKDIR /app

# Entrypoint script
COPY docker-entrypoint.sh ./
RUN chmod 755 docker-entrypoint.sh

# Install as the unprivileged user. Production dependencies only, from the
# lockfile. drizzle-kit is a dependency: the entrypoint and the Kubernetes
# migration Job run `npx drizzle-kit migrate`.
USER node
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Compiled application + client assets (owned by root: the app does not
# write to them)
COPY --from=build /app/dist/ dist/
COPY --from=build /app/public/ public/

# Drizzle migrations + config (needed at runtime for drizzle-kit migrate)
COPY drizzle/ drizzle/
COPY drizzle.config.ts ./
COPY tsconfig.json ./

EXPOSE 3000

# Express hides stack traces from error responses only in production
ENV NODE_ENV=production

# tini handles PID 1 reaping
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["./docker-entrypoint.sh"]
