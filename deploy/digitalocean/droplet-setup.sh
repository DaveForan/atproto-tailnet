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
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.coordinator.yml}"

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
  cp .env.coordinator.example .env
  # Generate strong secrets so placeholders never reach production.
  for var in SESSION_SECRET POSTGRES_PASSWORD COORDINATOR_API_KEY; do
    sed -i "s|^${var}=.*|${var}=$(openssl rand -hex 32)|" .env
  done
  if grep -q '^#\? *FEDERATION_KEY_ENCRYPTION_KEY=' .env; then
    sed -i "s|^#\? *FEDERATION_KEY_ENCRYPTION_KEY=.*|FEDERATION_KEY_ENCRYPTION_KEY=$(openssl rand -hex 32)|" .env
  else
    echo "FEDERATION_KEY_ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env
  fi
  chmod 600 .env
  echo ""
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo "  IMPORTANT: Edit $APP_DIR/.env before continuing."
  echo "  At minimum, set:"
  echo "    - TLS_STRATEGY=digitalocean"
  echo "    - DO_AUTH_TOKEN (DigitalOcean API token; scope it to DNS for your domain if your account allows custom scopes)"
  echo "    - CADDY_DNS_PLUGINS=github.com/caddy-dns/digitalocean"
  echo "    - OPERATOR_DIDS (your Bluesky DID, e.g. did:plc:...)"
  echo "    - ATPROTO_PRIVATE_KEY (ES256 JWK)"
  echo "  SESSION_SECRET, POSTGRES_PASSWORD and COORDINATOR_API_KEY were generated."
  echo "    - PUBLIC_URL"
  echo "    - BASE_DOMAIN"
  echo "    - APP_DOMAIN"
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo ""
  echo "After editing .env, run:"
  echo "  cd $APP_DIR && docker compose -f $COMPOSE_FILE up -d"
  exit 0
fi

if [ "$COMPOSE_FILE" = "docker-compose.production.yml" ]; then
  # Headscale mode: tenant data lives in a host directory that is mounted into
  # the app container at the same absolute path (see docker-compose.production.yml).
  HS_DIR="$(grep -E '^HEADSCALE_HOST_DATA_DIR=' .env | cut -d= -f2- || true)"
  HS_DIR="${HS_DIR:-/srv/atproto-tailnet/headscale}"
  echo "==> Creating Headscale data directory $HS_DIR"
  mkdir -p "$HS_DIR"
fi

echo "==> Pulling images"
docker compose -f "$COMPOSE_FILE" pull

echo "==> Building app image"
docker compose -f "$COMPOSE_FILE" build

echo "==> Starting services"
docker compose -f "$COMPOSE_FILE" up -d

echo "==> Waiting for health check..."
healthy=false
for _ in $(seq 1 30); do
  if docker compose -f "$COMPOSE_FILE" exec -T app wget -qO- http://localhost:3000/health > /dev/null 2>&1; then healthy=true; break; fi
  sleep 5
done
if [ "$healthy" = true ]; then
  echo "==> atproto-tailnet is running!"
else
  echo "==> App may still be starting. Check logs with:"
  echo "    docker compose -f $COMPOSE_FILE logs -f app"
fi

echo ""
echo "==> Setup complete."
echo "    Logs:    docker compose -f $COMPOSE_FILE logs -f"
echo "    Stop:    docker compose -f $COMPOSE_FILE down"
echo "    Restart: docker compose -f $COMPOSE_FILE restart"

# ---------------------------------------------------------------------------
# Firewall (optional -- uncomment if using ufw)
# ---------------------------------------------------------------------------
# ufw allow 22/tcp    # SSH
# ufw allow 80/tcp    # HTTP (Caddy redirect)
# ufw allow 443/tcp   # HTTPS
# ufw allow 443/udp   # HTTP/3 / QUIC
# ufw --force enable
