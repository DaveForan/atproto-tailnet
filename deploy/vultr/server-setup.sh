#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# atproto-tailnet  --  Vultr Cloud Compute bootstrap (coordinator mode)
#
# Run on a fresh Ubuntu 22.04+ / 24.04 Vultr instance (minimum 2 GB RAM).
# Installs Docker, clones the repo, and prepares the coordinator-mode stack.
#
# Usage:
#   ssh root@<instance-ip> 'bash -s' < deploy/vultr/server-setup.sh
#
# With explicit repo/branch:
#   ssh root@<instance-ip> 'REPO_URL=https://github.com/your-org/atproto-tailnet.git BRANCH=main bash -s' < deploy/vultr/server-setup.sh
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
apt-get install -y git curl

echo "==> Cloning repository"
if [ -d "$APP_DIR" ]; then
  echo "    $APP_DIR already exists, pulling latest..."
  cd "$APP_DIR"
  git pull origin "$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

echo "==> Setting up environment"
if [ ! -f .env ]; then
  cp .env.coordinator.example .env

  # Pre-generate secrets
  SESSION_SECRET=$(openssl rand -hex 32)
  POSTGRES_PASSWORD=$(openssl rand -hex 24)
  COORDINATOR_API_KEY=$(openssl rand -hex 32)
  FEDERATION_KEY_ENCRYPTION_KEY=$(openssl rand -hex 32)

  # Patch generated secrets into .env
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=${SESSION_SECRET}|" .env
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${POSTGRES_PASSWORD}|" .env
  sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://atproto_tailnet:${POSTGRES_PASSWORD}@postgres:5432/atproto_tailnet|" .env
  sed -i "s|^COORDINATOR_API_KEY=.*|COORDINATOR_API_KEY=${COORDINATOR_API_KEY}|" .env

  # Uncomment and set FEDERATION_KEY_ENCRYPTION_KEY
  sed -i "s|^# FEDERATION_KEY_ENCRYPTION_KEY=.*|FEDERATION_KEY_ENCRYPTION_KEY=${FEDERATION_KEY_ENCRYPTION_KEY}|" .env

  # Set Vultr TLS strategy
  sed -i "s|^TLS_STRATEGY=.*|TLS_STRATEGY=vultr|" .env
  sed -i "s|^# CADDY_DNS_PLUGINS=.*|CADDY_DNS_PLUGINS=github.com/caddy-dns/vultr|" .env

  # Ensure VULTR_API_KEY line exists (template may not include it)
  if ! grep -q '^VULTR_API_KEY=' .env; then
    echo "" >> .env
    echo "# Vultr API key for DNS-01 TLS" >> .env
    echo "VULTR_API_KEY=" >> .env
  fi

  echo ""
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo "  Secrets have been auto-generated in $APP_DIR/.env"
  echo ""
  echo "  You MUST still edit .env and set:"
  echo "    - PUBLIC_URL        (https://tailnets.yourdomain.com)"
  echo "    - BASE_DOMAIN       (ts.yourdomain.com)"
  echo "    - APP_DOMAIN        (tailnets.yourdomain.com)"
  echo "    - VULTR_API_KEY     (your Vultr API key for DNS-01 TLS)"
  echo ""
  echo "  After editing .env, run:"
  echo "    cd $APP_DIR && docker compose -f $COMPOSE_FILE up -d"
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo ""
  exit 0
fi

echo "==> Creating backup directory"
mkdir -p /opt/backups

echo "==> Adding swap (safety net for 2 GB instances)"
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "    2 GB swap enabled"
fi

echo "==> Pulling images"
docker compose -f "$COMPOSE_FILE" pull

echo "==> Building app and caddy images"
docker compose -f "$COMPOSE_FILE" build

echo "==> Starting services"
docker compose -f "$COMPOSE_FILE" up -d

echo "==> Waiting for health check..."
sleep 15
if docker compose -f "$COMPOSE_FILE" exec -T app curl -sf http://localhost:3000/health > /dev/null 2>&1; then
  echo "==> atproto-tailnet is running!"
else
  echo "==> App may still be starting. Check logs with:"
  echo "    docker compose -f $COMPOSE_FILE logs -f app"
fi

echo ""
echo "==> Configuring firewall"
ufw allow 22/tcp           # SSH
ufw allow 80/tcp           # HTTP (Caddy redirect)
ufw allow 443/tcp          # HTTPS
ufw allow 443/udp          # HTTP/3 / QUIC
ufw --force enable

echo ""
echo "==> Setup complete."
echo "    Logs:    docker compose -f $COMPOSE_FILE logs -f"
echo "    Stop:    docker compose -f $COMPOSE_FILE down"
echo "    Restart: docker compose -f $COMPOSE_FILE restart"
echo "    Health:  curl https://<your-domain>/health"
