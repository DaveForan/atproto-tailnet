#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# atproto-tailnet  --  Railway deploy & management
#
# Prerequisites:
#   - Railway CLI installed (npm i -g @railway/cli)
#   - Logged in (railway login)
#   - Project linked (railway link)
#
# Usage:
#   ./scripts/deploy-railway.sh deploy      # deploy current code
#   ./scripts/deploy-railway.sh logs        # tail live logs
#   ./scripts/deploy-railway.sh status      # show service status
#   ./scripts/deploy-railway.sh env         # show env vars
#   ./scripts/deploy-railway.sh env:set     # set required env vars interactively
#   ./scripts/deploy-railway.sh backup      # backup via Railway CLI
#   ./scripts/deploy-railway.sh restart     # restart the service
# ---------------------------------------------------------------------------
set -euo pipefail

CMD="${1:-deploy}"

check_cli() {
  if ! command -v railway &>/dev/null; then
    echo "ERROR: Railway CLI not found. Install with: npm i -g @railway/cli"
    exit 1
  fi
}

case "${CMD}" in
  deploy)
    check_cli
    echo "==> Deploying to Railway..."
    railway up --detach
    echo "Deploy triggered. Watch with: railway logs"
    ;;

  logs)
    check_cli
    railway logs --tail
    ;;

  status)
    check_cli
    railway status
    ;;

  env)
    check_cli
    railway variables
    ;;

  env:set)
    check_cli
    echo "Setting required environment variables..."
    echo "(Leave blank to skip, existing values are preserved)"
    echo ""

    read -r -p "SESSION_SECRET (32+ char random string): " val
    [ -n "$val" ] && railway variables set SESSION_SECRET="$val"

    read -r -p "PUBLIC_URL (e.g. https://tailnets.example.com): " val
    [ -n "$val" ] && railway variables set PUBLIC_URL="$val"

    read -r -p "BASE_DOMAIN (e.g. ts.example.com): " val
    [ -n "$val" ] && railway variables set BASE_DOMAIN="$val"

    read -r -p "ATPROTO_PRIVATE_KEY (ES256 JWK, optional): " val
    [ -n "$val" ] && railway variables set ATPROTO_PRIVATE_KEY="$val"

    echo ""
    echo "Done. Deploy with: ./scripts/deploy-railway.sh deploy"
    ;;

  backup)
    check_cli
    echo "==> Railway doesn't expose Docker volumes directly."
    echo "    For database backups, use the Railway Postgres plugin's snapshot feature,"
    echo "    or connect directly and run pg_dump:"
    echo ""
    echo "    railway connect postgres"
    echo "    pg_dump -U atproto_tailnet -d atproto_tailnet -F c > backup.dump"
    echo ""
    echo "    Headscale data backups require SSH/exec access to the container."
    ;;

  restart)
    check_cli
    echo "==> Restarting service..."
    railway service restart
    echo "Service restarted."
    ;;

  *)
    echo "Usage: $0 {deploy|logs|status|env|env:set|backup|restart}"
    exit 1
    ;;
esac
