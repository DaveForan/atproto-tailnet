#!/bin/sh
set -e

echo "Running database migrations..."
npx drizzle-kit migrate

echo "Starting atproto-tailnet..."
exec node dist/index.js
