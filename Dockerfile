# ---------------------------------------------------------------------------
# atproto-tailnet  --  multi-stage production build
# ---------------------------------------------------------------------------

# ---- build stage ---------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# Install dependencies first (layer cache)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json tsconfig.client.json esbuild.config.ts ./
COPY src/ src/
COPY public/css/ public/css/
RUN npm run build:client && npm run build

# ---- runtime stage -------------------------------------------------------
FROM node:22-alpine

RUN apk add --no-cache tini

WORKDIR /app

# Production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Compiled application + client assets
COPY --from=build /app/dist/ dist/
COPY --from=build /app/public/ public/

# Drizzle migrations + config (needed at runtime for drizzle-kit migrate)
COPY drizzle/ drizzle/
COPY drizzle.config.ts ./
COPY tsconfig.json ./

# Entrypoint script
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# drizzle-kit is a devDependency; install it standalone so migrations work
# without pulling in all devDependencies
RUN npm install drizzle-kit@$(node -e "console.log(require('./package.json').devDependencies['drizzle-kit'])")

EXPOSE 3000

# tini handles PID 1 reaping
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["./docker-entrypoint.sh"]
