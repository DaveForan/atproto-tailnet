#!/bin/sh
# Create or update the least-privilege PostgreSQL role of the relay
# (scripts/relay-db-role.sql) and write the relay's database URL.
#
# Security: the password is random, made at the first run, and kept in the
# relay's volume only. The files are for root; the relay-keys service gives
# the URL file to the relay's user.

set -eu
umask 077

DIR="${RELAY_DIR:-/relay}"
ROLE="${RELAY_DB_ROLE:-tailnet_relay}"

if [ ! -s "$DIR/db-password" ]; then
  head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$DIR/.db-password.new"
  mv -f "$DIR/.db-password.new" "$DIR/db-password"
fi

RELAY_DB_PASSWORD="$(cat "$DIR/db-password")"
export RELAY_DB_PASSWORD
psql -q -v relay_role="$ROLE" -v gateway=1 -f /relay-db-role.sql

printf 'postgresql://%s:%s@%s:%s/%s\n' "$ROLE" "$RELAY_DB_PASSWORD" "$PGHOST" "${PGPORT:-5432}" "$PGDATABASE" > "$DIR/.database-url.new"
mv -f "$DIR/.database-url.new" "$DIR/database-url"
echo "database role $ROLE is ready"
