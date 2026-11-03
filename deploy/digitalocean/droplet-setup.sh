#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# atproto-tailnet  --  DigitalOcean Droplet bootstrap
#
# Run on a fresh Ubuntu 22.04+ Droplet (minimum 2 GB RAM / 1 vCPU).
# Installs Docker, clones the repo, and brings up the production stack.
#
# Usage:
#   ssh root@your-droplet 'bash -s' < deploy/digitalocean/droplet-setup.sh
#
# Or copy to the droplet and run interactively to fill in env vars.
# ---------------------------------------------------------------------------
set -euo pipefail

APP_DIR="/opt/atproto-tailnet"
REPO_URL="${REPO_URL:-https://github.com/your-org/atproto-tailnet.git}"
BRANCH="${BRANCH:-main}"

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

echo "==> Installing git"
apt-get install -y git

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
  cp .env.example .env
  echo ""
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo "  IMPORTANT: Edit $APP_DIR/.env before continuing."
  echo "  At minimum, set:"
  echo "    - SESSION_SECRET (>= 32 chars)"
  echo "    - POSTGRES_PASSWORD"
  echo "    - PUBLIC_URL"
  echo "    - BASE_DOMAIN"
  echo "    - CF_API_TOKEN (for wildcard TLS)"
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo ""
  echo "After editing .env, run:"
  echo "  cd $APP_DIR && docker compose -f docker-compose.production.yml up -d"
  exit 0
fi

echo "==> Creating data directories"
mkdir -p data/headscale

echo "==> Pulling images"
docker compose -f docker-compose.production.yml pull

echo "==> Building app image"
docker compose -f docker-compose.production.yml build

echo "==> Starting services"
docker compose -f docker-compose.production.yml up -d

echo "==> Waiting for health check..."
sleep 10
if curl -sf http://localhost:3000/health > /dev/null; then
  echo "==> atproto-tailnet is running!"
else
  echo "==> App may still be starting. Check logs with:"
  echo "    docker compose -f docker-compose.production.yml logs -f app"
fi

echo ""
echo "==> Setup complete."
echo "    Logs:    docker compose -f docker-compose.production.yml logs -f"
echo "    Stop:    docker compose -f docker-compose.production.yml down"
echo "    Restart: docker compose -f docker-compose.production.yml restart"

# ---------------------------------------------------------------------------
# Firewall (optional -- uncomment if using ufw)
# ---------------------------------------------------------------------------
# ufw allow 22/tcp    # SSH
# ufw allow 80/tcp    # HTTP (Caddy redirect)
# ufw allow 443/tcp   # HTTPS
# ufw allow 443/udp   # HTTP/3 / QUIC
# ufw allow 10001:10100/tcp  # Headscale tenant ports
# ufw --force enable
