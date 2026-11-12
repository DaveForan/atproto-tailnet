#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# atproto-tailnet  --  Hetzner Cloud server bootstrap
#
# Run on a fresh Ubuntu 22.04+ Hetzner Cloud server (CX22: 2 vCPU / 4 GB RAM).
# Installs Docker, clones the repo, and prepares the coordinator-mode stack.
#
# Usage:
#   ssh root@<server-ip> 'bash -s' < deploy/hetzner/server-setup.sh
#
# Or with custom repo/branch:
#   ssh root@<server-ip> "REPO_URL=https://github.com/you/atproto-tailnet.git BRANCH=main bash -s" \
#     < deploy/hetzner/server-setup.sh
# ---------------------------------------------------------------------------
set -euo pipefail

APP_DIR="/opt/atproto-tailnet"
REPO_URL="${REPO_URL:-https://github.com/your-org/atproto-tailnet.git}"
BRANCH="${BRANCH:-main}"
COMPOSE_FILE="docker-compose.coordinator.yml"

echo "==> Updating system packages"
apt-get update -y
apt-get upgrade -y

echo "==> Installing Docker"
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi

# Docker Compose plugin (v2)
if ! docker compose version &>/dev/null; then
  apt-get install -y docker-compose-plugin
fi

echo "==> Installing dependencies"
apt-get install -y git curl jq

echo "==> Cloning repository"
if [ -d "$APP_DIR" ]; then
  echo "    $APP_DIR already exists, pulling latest..."
  cd "$APP_DIR"
  git pull origin "$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

echo "==> Creating backup directory"
mkdir -p /opt/backups

echo "==> Setting up environment"
if [ ! -f .env ]; then
  cp .env.coordinator.example .env

  # Pre-fill Hetzner-specific TLS settings
  sed -i 's/^TLS_STRATEGY=.*/TLS_STRATEGY=hetzner/' .env
  sed -i 's|^# CADDY_DNS_PLUGINS=.*|CADDY_DNS_PLUGINS=github.com/caddy-dns/hetzner|' .env

  # Generate secrets automatically
  SESSION_SECRET=$(openssl rand -hex 32)
  POSTGRES_PASSWORD=$(openssl rand -hex 16)
  COORDINATOR_API_KEY=$(openssl rand -hex 32)
  FEDERATION_KEY=$(openssl rand -hex 32)

  sed -i "s/^SESSION_SECRET=.*/SESSION_SECRET=${SESSION_SECRET}/" .env
  sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=${POSTGRES_PASSWORD}/" .env
  sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://atproto_tailnet:${POSTGRES_PASSWORD}@postgres:5432/atproto_tailnet|" .env
  sed -i "s/^COORDINATOR_API_KEY=.*/COORDINATOR_API_KEY=${COORDINATOR_API_KEY}/" .env
  sed -i "s|^# FEDERATION_KEY_ENCRYPTION_KEY=.*|FEDERATION_KEY_ENCRYPTION_KEY=${FEDERATION_KEY}|" .env

  echo ""
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo "  Environment file created at $APP_DIR/.env"
  echo "  Secrets have been auto-generated."
  echo ""
  echo "  You MUST still set these manually:"
  echo "    - PUBLIC_URL        (e.g. https://tailnets.example.com)"
  echo "    - BASE_DOMAIN       (e.g. ts.example.com)"
  echo "    - APP_DOMAIN        (e.g. tailnets.example.com)"
  echo "    - HETZNER_API_TOKEN (Hetzner DNS API token from dns.hetzner.com)"
  echo ""
  echo "  Optional:"
  echo "    - ATPROTO_PRIVATE_KEY (for production AT Proto OAuth)"
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo ""
  echo "After editing .env, run:"
  echo "  cd $APP_DIR && docker compose -f $COMPOSE_FILE up -d"
  exit 0
fi

echo "==> Pulling images"
docker compose -f "$COMPOSE_FILE" pull

echo "==> Building app and Caddy images"
docker compose -f "$COMPOSE_FILE" build

echo "==> Starting services"
docker compose -f "$COMPOSE_FILE" up -d

echo "==> Waiting for services to start..."
sleep 15

# Check health
if docker compose -f "$COMPOSE_FILE" exec -T app curl -sf http://localhost:3000/health > /dev/null 2>&1; then
  echo "==> atproto-tailnet is running!"
elif docker compose -f "$COMPOSE_FILE" ps | grep -q "running"; then
  echo "==> Containers are up. App may still be starting."
  echo "    Check logs: docker compose -f $COMPOSE_FILE logs -f app"
else
  echo "==> WARNING: Some containers may have failed to start."
  echo "    Check logs: docker compose -f $COMPOSE_FILE logs"
fi

echo ""
echo "==> Setup complete."
echo "    Compose:  $COMPOSE_FILE"
echo "    Logs:     docker compose -f $COMPOSE_FILE logs -f"
echo "    Stop:     docker compose -f $COMPOSE_FILE down"
echo "    Restart:  docker compose -f $COMPOSE_FILE restart"
echo "    Status:   docker compose -f $COMPOSE_FILE ps"

# ---------------------------------------------------------------------------
# Firewall note: Hetzner Cloud firewall is preferred over host-level ufw.
# If you created the server with --firewall atproto-tailnet-fw (per AGENT.md),
# the firewall is already applied at the network level.
#
# If you need host-level rules instead, uncomment:
# ---------------------------------------------------------------------------
# ufw allow 22/tcp           # SSH
# ufw allow 80/tcp           # HTTP (Caddy redirect)
# ufw allow 443/tcp          # HTTPS
# ufw allow 443/udp          # HTTP/3 / QUIC
# ufw --force enable
