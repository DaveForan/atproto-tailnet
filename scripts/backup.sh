#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# atproto-tailnet backup
#
# Dumps PostgreSQL and archives the coordinator and Caddy data into a
# timestamped archive. The default stack is docker-compose.coordinator.yml.
#
# Usage:
#   ./scripts/backup.sh                       # default: ./backups/
#   ./scripts/backup.sh /mnt/backups          # custom output dir
#   COMPOSE_FILE=docker-compose.coordinator.dev.yml ./scripts/backup.sh
# ---------------------------------------------------------------------------
set -euo pipefail

BACKUP_DIR="${1:-./backups}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_NAME="atproto-tailnet-${TIMESTAMP}"
WORK_DIR="${BACKUP_DIR}/${BACKUP_NAME}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.coordinator.yml}"

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

echo "==> Backing up coordinator data (Noise control key)..."
if docker compose -f "${COMPOSE_FILE}" ps coordinator --status running -q 2>/dev/null | grep -q .; then
  docker compose -f "${COMPOSE_FILE}" exec -T coordinator \
    tar czf - -C /var/lib/coordinator . \
    > "${WORK_DIR}/coordinator-data.tar.gz"
  chmod 600 "${WORK_DIR}/coordinator-data.tar.gz"
  echo "    Coordinator data archived (contains the control private key — store it securely)"
else
  echo "    Coordinator not running in this stack, skipping"
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
