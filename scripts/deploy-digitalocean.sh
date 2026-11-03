#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# atproto-tailnet  --  DigitalOcean Droplet deploy & management
#
# Prerequisites:
#   - doctl CLI installed (snap install doctl / brew install doctl)
#   - Authenticated (doctl auth init)
#   - SSH key registered with DO
#
# Usage:
#   ./scripts/deploy-digitalocean.sh deploy       # provision droplet + DB
#   ./scripts/deploy-digitalocean.sh status        # show droplet & DB status
#   ./scripts/deploy-digitalocean.sh ssh           # SSH into the droplet
#   ./scripts/deploy-digitalocean.sh logs          # tail app logs via SSH
#   ./scripts/deploy-digitalocean.sh update        # pull latest & restart
#   ./scripts/deploy-digitalocean.sh backup        # trigger DB + volume snapshot
#   ./scripts/deploy-digitalocean.sh destroy       # tear down all resources
# ---------------------------------------------------------------------------
set -euo pipefail

CMD="${1:-deploy}"

APP_NAME="atproto-tailnet"
REGION="${DO_REGION:-nyc3}"
DROPLET_SIZE="${DO_DROPLET_SIZE:-s-2vcpu-4gb}"
DB_SIZE="${DO_DB_SIZE:-db-s-1vcpu-1gb}"
SSH_KEY_NAME="${DO_SSH_KEY:-}"
VOLUME_SIZE="${DO_VOLUME_SIZE:-20}"

check_cli() {
  if ! command -v doctl &>/dev/null; then
    echo "ERROR: doctl CLI not found."
    echo "  Install: snap install doctl  OR  brew install doctl"
    echo "  Auth:    doctl auth init"
    exit 1
  fi
}

get_droplet_id() {
  doctl compute droplet list --tag-name "${APP_NAME}" --format ID --no-header 2>/dev/null | head -1
}

get_droplet_ip() {
  doctl compute droplet list --tag-name "${APP_NAME}" --format PublicIPv4 --no-header 2>/dev/null | head -1
}

get_db_id() {
  doctl databases list --format ID,Name --no-header 2>/dev/null | grep "${APP_NAME}" | awk '{print $1}'
}

get_volume_id() {
  doctl compute volume list --format ID,Name --no-header 2>/dev/null | grep "${APP_NAME}" | awk '{print $1}'
}

case "${CMD}" in
  deploy)
    check_cli
    echo "==> Provisioning DigitalOcean resources..."
    echo "    Region: ${REGION}, Droplet: ${DROPLET_SIZE}, DB: ${DB_SIZE}"
    echo ""

    # Resolve SSH key
    if [ -z "${SSH_KEY_NAME}" ]; then
      echo "Available SSH keys:"
      doctl compute ssh-key list --format ID,Name,FingerPrint
      echo ""
      read -r -p "SSH key ID or fingerprint: " SSH_KEY_NAME
    fi

    # Create managed database
    echo "==> Creating managed PostgreSQL database..."
    doctl databases create "${APP_NAME}-db" \
      --engine pg \
      --version 17 \
      --region "${REGION}" \
      --size "${DB_SIZE}" \
      --num-nodes 1 \
      --wait

    DB_ID="$(get_db_id)"
    echo "    Database ID: ${DB_ID}"

    # Create a database and user
    doctl databases db create "${DB_ID}" atproto_tailnet
    doctl databases user create "${DB_ID}" atproto_tailnet

    # Create block storage volume
    echo "==> Creating block storage volume (${VOLUME_SIZE} GB)..."
    doctl compute volume create "${APP_NAME}-data" \
      --region "${REGION}" \
      --size "${VOLUME_SIZE}GiB" \
      --fs-type ext4

    VOLUME_ID="$(get_volume_id)"
    echo "    Volume ID: ${VOLUME_ID}"

    # Create droplet
    echo "==> Creating droplet..."
    doctl compute droplet create "${APP_NAME}" \
      --image ubuntu-22-04-x64 \
      --size "${DROPLET_SIZE}" \
      --region "${REGION}" \
      --ssh-keys "${SSH_KEY_NAME}" \
      --tag-name "${APP_NAME}" \
      --user-data-file deploy/digitalocean/droplet-setup.sh \
      --volumes "${VOLUME_ID}" \
      --wait

    DROPLET_IP="$(get_droplet_ip)"
    echo ""
    echo "Droplet created: ${DROPLET_IP}"
    echo ""

    # Get DB connection string
    DB_CONN="$(doctl databases connection "${DB_ID}" --format URI --no-header)"
    echo "Database connection: ${DB_CONN}"
    echo ""
    echo "NEXT STEPS:"
    echo "  1. Wait ~3 min for droplet setup to complete"
    echo "  2. SSH in: ssh root@${DROPLET_IP}"
    echo "  3. Configure .env with the database connection string above"
    echo "  4. Start services: cd /opt/atproto-tailnet && docker compose -f docker-compose.production.yml up -d"
    echo "  5. Point DNS: A record for your domain -> ${DROPLET_IP}"
    echo "     Wildcard: *.ts.yourdomain.com -> ${DROPLET_IP}"
    ;;

  status)
    check_cli
    echo "==> Droplet:"
    doctl compute droplet list --tag-name "${APP_NAME}" --format ID,Name,PublicIPv4,Status,Memory,VCPUs,Disk
    echo ""
    echo "==> Database:"
    doctl databases list --format ID,Name,Engine,Status,Region,Size,NumNodes 2>/dev/null | grep -E "(ID|${APP_NAME})" || echo "    No database found"
    echo ""
    echo "==> Volume:"
    doctl compute volume list --format ID,Name,Size,Region,DropletIDs 2>/dev/null | grep -E "(ID|${APP_NAME})" || echo "    No volume found"
    ;;

  ssh)
    check_cli
    IP="$(get_droplet_ip)"
    if [ -z "${IP}" ]; then
      echo "ERROR: No droplet found with tag '${APP_NAME}'"
      exit 1
    fi
    echo "==> Connecting to ${IP}..."
    ssh "root@${IP}"
    ;;

  logs)
    check_cli
    IP="$(get_droplet_ip)"
    if [ -z "${IP}" ]; then
      echo "ERROR: No droplet found with tag '${APP_NAME}'"
      exit 1
    fi
    echo "==> Tailing logs on ${IP}..."
    ssh "root@${IP}" "cd /opt/atproto-tailnet && docker compose -f docker-compose.production.yml logs -f --tail=100 app"
    ;;

  update)
    check_cli
    IP="$(get_droplet_ip)"
    if [ -z "${IP}" ]; then
      echo "ERROR: No droplet found with tag '${APP_NAME}'"
      exit 1
    fi
    echo "==> Updating ${APP_NAME} on ${IP}..."
    ssh "root@${IP}" bash -s <<'REMOTE'
      set -euo pipefail
      cd /opt/atproto-tailnet
      git pull origin main
      docker compose -f docker-compose.production.yml build app
      docker compose -f docker-compose.production.yml up -d app
      echo "Update complete."
      docker compose -f docker-compose.production.yml ps
REMOTE
    ;;

  backup)
    check_cli
    echo "==> Creating database backup..."
    DB_ID="$(get_db_id)"
    if [ -n "${DB_ID}" ]; then
      doctl databases backups list "${DB_ID}" --format Size,CreatedAt
      echo "    (Managed databases auto-backup daily. Use DO console for manual snapshot.)"
    else
      echo "    No managed database found"
    fi

    echo ""
    echo "==> Creating volume snapshot..."
    VOLUME_ID="$(get_volume_id)"
    if [ -n "${VOLUME_ID}" ]; then
      SNAP_NAME="${APP_NAME}-snap-$(date +%Y%m%d-%H%M%S)"
      doctl compute volume snapshot "${VOLUME_ID}" --snapshot-name "${SNAP_NAME}"
      echo "    Volume snapshot created: ${SNAP_NAME}"
    else
      echo "    No volume found"
    fi

    echo ""
    echo "==> Running app-level backup on droplet..."
    IP="$(get_droplet_ip)"
    if [ -n "${IP}" ]; then
      ssh "root@${IP}" "cd /opt/atproto-tailnet && bash scripts/backup.sh /data/backups"
    fi
    ;;

  destroy)
    check_cli
    echo "WARNING: This will destroy all ${APP_NAME} resources on DigitalOcean."
    read -r -p "Type '${APP_NAME}' to confirm: " confirm
    if [ "${confirm}" != "${APP_NAME}" ]; then
      echo "Aborted."
      exit 0
    fi

    echo "==> Destroying droplet..."
    DROPLET_ID="$(get_droplet_id)"
    [ -n "${DROPLET_ID}" ] && doctl compute droplet delete "${DROPLET_ID}" --force

    echo "==> Destroying database..."
    DB_ID="$(get_db_id)"
    [ -n "${DB_ID}" ] && doctl databases delete "${DB_ID}" --force

    echo "==> Destroying volume..."
    VOLUME_ID="$(get_volume_id)"
    [ -n "${VOLUME_ID}" ] && doctl compute volume delete "${VOLUME_ID}" --force

    echo "All resources destroyed."
    ;;

  *)
    echo "Usage: $0 {deploy|status|ssh|logs|update|backup|destroy}"
    exit 1
    ;;
esac
