#!/bin/sh
set -e

# With several replicas, run the migrations once in a separate job
# (`npx drizzle-kit migrate`) and start the replicas with SKIP_MIGRATIONS=1.
if [ "${SKIP_MIGRATIONS:-}" = "1" ]; then
  echo "Skipping database migrations (SKIP_MIGRATIONS=1)"
else
  echo "Running database migrations..."
  npx drizzle-kit migrate
fi

echo "Starting atproto-tailnet..."
exec node dist/index.js
