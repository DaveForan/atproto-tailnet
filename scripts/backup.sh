#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# atproto-tailnet backup
#
# Dumps PostgreSQL and tars the Headscale data directory into a timestamped
# archive. Works with both local dev (docker compose) and production
# (docker-compose.production.yml) stacks.
#
# Usage:
#   ./scripts/backup.sh                       # default: ./backups/
#   ./scripts/backup.sh /mnt/backups          # custom output dir
#   COMPOSE_FILE=docker-compose.production.yml ./scripts/backup.sh
# ---------------------------------------------------------------------------
set -euo pipefail

BACKUP_DIR="${1:-./backups}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_NAME="atproto-tailnet-${TIMESTAMP}"
WORK_DIR="${BACKUP_DIR}/${BACKUP_NAME}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.production.yml}"

PG_USER="${POSTGRES_USER:-atproto_tailnet}"
PG_DB="${POSTGRES_DB:-atproto_tailnet}"

mkdir -p "${WORK_DIR}"

echo "==> Backing up PostgreSQL..."
if docker compose -f "${COMPOSE_FILE}" ps postgres --status running -q >/dev/null 2>&1; then
  docker compose -f "${COMPOSE_FILE}" exec -T postgres \
    pg_dump -U "${PG_USER}" -d "${PG_DB}" --format=custom \
    > "${WORK_DIR}/database.dump"
  echo "    Database dumped (custom format)"
else
  echo "    WARNING: postgres container not running, skipping DB dump"
fi

echo "==> Backing up Headscale data..."
HEADSCALE_DATA="${HEADSCALE_DATA_DIR:-./data/headscale}"
if docker compose -f "${COMPOSE_FILE}" ps app --status running -q >/dev/null 2>&1; then
  docker compose -f "${COMPOSE_FILE}" exec -T app \
    tar czf - -C /data headscale \
    > "${WORK_DIR}/headscale-data.tar.gz"
  echo "    Headscale data archived from container volume"
elif [ -d "${HEADSCALE_DATA}" ]; then
  tar czf "${WORK_DIR}/headscale-data.tar.gz" -C "$(dirname "${HEADSCALE_DATA}")" "$(basename "${HEADSCALE_DATA}")"
  echo "    Headscale data archived from local dir"
else
  echo "    WARNING: no Headscale data found, skipping"
fi

echo "==> Backing up Caddy data..."
if docker compose -f "${COMPOSE_FILE}" ps caddy --status running -q >/dev/null 2>&1; then
  docker compose -f "${COMPOSE_FILE}" exec -T caddy \
    tar czf - -C /data . \
    > "${WORK_DIR}/caddy-data.tar.gz" 2>/dev/null || true
  echo "    Caddy data archived"
fi

echo "==> Saving environment (redacted)..."
if [ -f .env ]; then
  grep -v -E '(SECRET|PASSWORD|PRIVATE_KEY|TOKEN)' .env > "${WORK_DIR}/env-redacted.txt" || true
  echo "    Redacted .env saved (secrets stripped)"
fi

echo "==> Creating final archive..."
tar czf "${BACKUP_DIR}/${BACKUP_NAME}.tar.gz" -C "${BACKUP_DIR}" "${BACKUP_NAME}"
rm -rf "${WORK_DIR}"

SIZE=$(du -h "${BACKUP_DIR}/${BACKUP_NAME}.tar.gz" | cut -f1)
echo ""
echo "Backup complete: ${BACKUP_DIR}/${BACKUP_NAME}.tar.gz (${SIZE})"
echo "Restore with:    ./scripts/restore.sh ${BACKUP_DIR}/${BACKUP_NAME}.tar.gz"
