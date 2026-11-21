#!/bin/sh
# Server side of deploy/deploy.sh. Run it in the repository on the server,
# after `git pull`:
#
#   sh deploy/remote-deploy.sh <expected-commit> [--restart-all]
#
# Steps: check the commit, back up the database, build the images, apply the
# migrations to a copy of the database, start the new containers, wait until
# they are healthy. It stops at the first failure. Before the start step a
# failure leaves the running stack as it was.
#
# Security: this script never prints a value from .env.

set -eu

EXPECTED="${1:?usage: remote-deploy.sh <expected-commit> [--restart-all]}"
RESTART_ALL="${2:-}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.coordinator.yml}"
BACKUP_DIR="${BACKUP_DIR:-/root/backups}"
KEEP_BACKUPS="${KEEP_BACKUPS:-14}"
C="docker compose -f $COMPOSE_FILE"

step() { printf '\n== %s\n' "$1"; }
fail() { printf 'DEPLOY STOPPED: %s\n' "$1" >&2; exit 1; }
val() { grep -E "^$1=" .env | head -1 | cut -d= -f2-; }

step "Commit"
[ -f .env ] || fail "no .env in $(pwd)"
[ -z "$(git status --porcelain)" ] || fail "the server tree has local changes"
HEAD_NOW="$(git rev-parse HEAD)"
[ "$HEAD_NOW" = "$EXPECTED" ] || fail "server is at $HEAD_NOW, expected $EXPECTED"
echo "server tree is clean at $(git rev-parse --short HEAD)"
$C config -q || fail "the compose file does not accept this .env"

PG_USER="$(val POSTGRES_USER)"; PG_USER="${PG_USER:-atproto_tailnet}"
PG_DB="$(val POSTGRES_DB)"; PG_DB="${PG_DB:-atproto_tailnet}"
PG_PASSWORD="$(val POSTGRES_PASSWORD)"
[ -n "$PG_PASSWORD" ] || fail "POSTGRES_PASSWORD is not set in .env"
PROJECT="$($C config --format json 2>/dev/null | sed -n 's/^  "name": "\(.*\)",$/\1/p' | head -1)"
PROJECT="${PROJECT:-$(basename "$(pwd)")}"
NETWORK="${PROJECT}_internal"

step "Database backup"
$C ps --status running --services </dev/null | grep -qx postgres || fail "postgres is not running: start the stack by hand the first time"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
BACKUP="$BACKUP_DIR/pre-$(git rev-parse --short HEAD)-$(date -u +%Y%m%d-%H%M%S).sql.gz"
( umask 077; $C exec -T postgres pg_dump -U "$PG_USER" "$PG_DB" </dev/null | gzip > "$BACKUP" )
gzip -t "$BACKUP" || fail "the backup is not a valid gzip file"
[ "$(gunzip -c "$BACKUP" | head -c 2000 | grep -c 'PostgreSQL database dump')" -ge 1 ] || fail "the backup is not a database dump"
echo "backup: $BACKUP ($(du -h "$BACKUP" | cut -f1))"
# Keep the newest backups only
ls -1t "$BACKUP_DIR"/pre-*.sql.gz 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))" | while read -r old; do rm -f "$old"; done

step "Build"
$C build </dev/null >/tmp/deploy-build.log 2>&1 || { tail -30 /tmp/deploy-build.log; fail "the image build failed (full log: /tmp/deploy-build.log)"; }
echo "images built"

step "Migrations on a copy of the database"
DRY_DB="deploy_dryrun"
DRY_URL="postgresql://$PG_USER:$PG_PASSWORD@postgres:5432/$DRY_DB"
cleanup_dry() {
  docker rm -f deploy-dryrun-coord >/dev/null 2>&1 || true
  $C exec -T postgres psql -U "$PG_USER" -d postgres -q -c "DROP DATABASE IF EXISTS $DRY_DB" </dev/null >/dev/null 2>&1 || true
}
trap cleanup_dry EXIT
cleanup_dry
$C exec -T postgres psql -U "$PG_USER" -d postgres -q -c "CREATE DATABASE $DRY_DB" </dev/null
gunzip -c "$BACKUP" | $C exec -T postgres psql -U "$PG_USER" -d "$DRY_DB" -q -v ON_ERROR_STOP=1 >/dev/null 2>/tmp/deploy-restore.err \
  || { tail -5 /tmp/deploy-restore.err; fail "the backup does not restore"; }
count() { $C exec -T postgres psql -U "$PG_USER" -d "$1" -At -c "SELECT (SELECT count(*) FROM users) || ' users, ' || (SELECT count(*) FROM tenants) || ' tailnets, ' || (SELECT count(*) FROM coord_nodes) || ' devices'" </dev/null; }
BEFORE="$(count "$DRY_DB")"
docker run --rm --network "$NETWORK" -e DATABASE_URL="$DRY_URL" --entrypoint npx "${PROJECT}-app" drizzle-kit migrate </dev/null >/tmp/deploy-migrate.log 2>&1 \
  || { tail -15 /tmp/deploy-migrate.log | grep -v 'postgresql://'; fail "the service migrations failed on the copy"; }
docker run -d --name deploy-dryrun-coord --network "$NETWORK" \
  -e COORD_ROLE=control -e COORD_STORE_BACKEND=postgres -e COORD_LISTEN=0.0.0.0:9443 \
  -e DATABASE_URL="$DRY_URL" -e COORD_ADMIN_KEY="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')" \
  -e COORD_CONTROL_KEY_PATH=/tmp/control.key "${PROJECT}-coordinator" </dev/null >/dev/null
ok=""
for _ in $(seq 1 30); do
  if docker logs deploy-dryrun-coord 2>&1 | grep -q '"message":"listening"'; then ok=1; break; fi
  [ "$(docker inspect -f '{{.State.Running}}' deploy-dryrun-coord 2>/dev/null)" = "true" ] || break
  sleep 1
done
[ -n "$ok" ] || { docker logs deploy-dryrun-coord 2>&1 | grep -v 'postgresql://' | tail -8; fail "the coordinator migrations failed on the copy"; }
AFTER="$(count "$DRY_DB")"
[ "$BEFORE" = "$AFTER" ] || fail "row counts changed on the copy: before '$BEFORE', after '$AFTER'"
echo "migrations apply; the copy still has $AFTER"
cleanup_dry
trap - EXIT

step "Start"
if [ "$RESTART_ALL" = "--restart-all" ]; then
  $C down --remove-orphans </dev/null 2>&1 | tail -2
fi
if ! $C up -d --remove-orphans </dev/null >/tmp/deploy-up.log 2>&1; then
  tail -15 /tmp/deploy-up.log
  fail "the stack did not start. If a network changed, run the deploy again with --restart-all. The backup is $BACKUP"
fi

step "Health"
healthy=""
for _ in $(seq 1 60); do
  bad="$($C ps -a --format '{{.Service}}|{{.State}}|{{.Health}}|{{.ExitCode}}' </dev/null | awk -F'|' '
    $2 == "running" && ($3 == "" || $3 == "healthy") { next }
    $2 == "exited" && $4 == "0" { next }
    { print $1 "(" $2 ($3 != "" ? "/" $3 : "") ")" }' | tr '\n' ' ')"
  if [ -z "$bad" ]; then healthy=1; break; fi
  sleep 3
done
$C ps -a --format '{{.Service}}: {{.Status}}' </dev/null
[ -n "$healthy" ] || fail "not healthy after 3 minutes: $bad. The backup is $BACKUP"
echo "all services are healthy at $(git rev-parse --short HEAD)"
