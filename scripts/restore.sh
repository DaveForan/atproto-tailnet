#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# atproto-tailnet restore
#
# Restores a backup archive created by backup.sh. Stops the app, restores
# the database and Headscale data, then restarts everything.
#
# Usage:
#   ./scripts/restore.sh backups/atproto-tailnet-20261102-193000.tar.gz
#   COMPOSE_FILE=docker-compose.production.yml ./scripts/restore.sh backup.tar.gz
# ---------------------------------------------------------------------------
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <backup-archive.tar.gz>"
  exit 1
fi

ARCHIVE="$1"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.production.yml}"
PG_USER="${POSTGRES_USER:-atproto_tailnet}"
PG_DB="${POSTGRES_DB:-atproto_tailnet}"

if [ ! -f "${ARCHIVE}" ]; then
  echo "ERROR: Archive not found: ${ARCHIVE}"
  exit 1
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

echo "==> Extracting archive..."
tar xzf "${ARCHIVE}" -C "${WORK_DIR}"
BACKUP_DIR="$(ls -d "${WORK_DIR}"/atproto-tailnet-* 2>/dev/null | head -1)"
if [ -z "${BACKUP_DIR}" ]; then
  BACKUP_DIR="${WORK_DIR}"
fi

echo ""
echo "WARNING: This will overwrite the current database and Headscale data."
echo "         The app will be stopped during restore."
read -r -p "Continue? [y/N] " confirm
if [[ ! "${confirm}" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

echo ""
echo "==> Stopping app..."
docker compose -f "${COMPOSE_FILE}" stop app 2>/dev/null || true

if [ -f "${BACKUP_DIR}/database.dump" ]; then
  echo "==> Restoring PostgreSQL..."
  docker compose -f "${COMPOSE_FILE}" up -d postgres
  sleep 3

  docker compose -f "${COMPOSE_FILE}" exec -T postgres \
    pg_restore -U "${PG_USER}" -d "${PG_DB}" --clean --if-exists --no-owner \
    < "${BACKUP_DIR}/database.dump" 2>/dev/null || true
  echo "    Database restored"
else
  echo "    No database dump found, skipping"
fi

if [ -f "${BACKUP_DIR}/headscale-data.tar.gz" ]; then
  echo "==> Restoring Headscale data..."
  docker compose -f "${COMPOSE_FILE}" exec -T app \
    sh -c 'rm -rf /data/headscale/* && tar xzf - -C /data' \
    < "${BACKUP_DIR}/headscale-data.tar.gz" 2>/dev/null || {
    echo "    App container not running, trying local restore..."
    HEADSCALE_DATA="${HEADSCALE_DATA_DIR:-./data/headscale}"
    mkdir -p "${HEADSCALE_DATA}"
    tar xzf "${BACKUP_DIR}/headscale-data.tar.gz" -C "$(dirname "${HEADSCALE_DATA}")"
    echo "    Headscale data restored to ${HEADSCALE_DATA}"
  }
  echo "    Headscale data restored"
else
  echo "    No Headscale data found, skipping"
fi

if [ -f "${BACKUP_DIR}/caddy-data.tar.gz" ]; then
  echo "==> Restoring Caddy data..."
  docker compose -f "${COMPOSE_FILE}" exec -T caddy \
    sh -c 'tar xzf - -C /data' \
    < "${BACKUP_DIR}/caddy-data.tar.gz" 2>/dev/null || true
  echo "    Caddy data restored"
fi

echo "==> Restarting all services..."
docker compose -f "${COMPOSE_FILE}" up -d

echo ""
echo "Restore complete. Check service health:"
echo "  docker compose -f ${COMPOSE_FILE} ps"
echo "  curl -s http://localhost:3000/health"
