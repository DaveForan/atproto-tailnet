#!/bin/sh
# Deploy the pushed master branch to a server in one command.
#
#   DEPLOY_HOST=root@203.0.113.10 deploy/deploy.sh [--restart-all] [--check]
#
# Settings (environment, or a file `deploy/deploy.env` that git ignores):
#   DEPLOY_HOST      user@host of the server (required)
#   DEPLOY_SSH_KEY   private key file (optional)
#   DEPLOY_DIR       repository on the server (default /opt/atproto-tailnet)
#   DEPLOY_BRANCH    branch to deploy (default master)
#
# Steps:
#   1. Parity: the local tree is clean and equal to origin/<branch>. The
#      server tree is clean. Only commits that are on the remote are deployed.
#   2. Server (deploy/remote-deploy.sh): database backup, image build,
#      migrations on a copy of the database, start, wait for health.
#   3. Verify from this machine: the public URLs answer, and the admin API of
#      the coordinator is not reachable.
#
# --check        do steps 1 and 3 only; change nothing on the server.
# --restart-all  stop the full stack before the start. Necessary when a
#                Docker network changed. About one minute of downtime.

set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/deploy.env" ] && . "$HERE/deploy.env"

HOST="${DEPLOY_HOST:?set DEPLOY_HOST (user@host), or write it to deploy/deploy.env}"
DIR="${DEPLOY_DIR:-/opt/atproto-tailnet}"
BRANCH="${DEPLOY_BRANCH:-master}"
RESTART_ALL=""
CHECK_ONLY=""
for arg in "$@"; do
  case "$arg" in
    --restart-all) RESTART_ALL="--restart-all" ;;
    --check) CHECK_ONLY=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n== %s\n' "$1"; }
fail() { printf 'DEPLOY STOPPED: %s\n' "$1" >&2; exit 1; }
remote() {
  if [ -n "${DEPLOY_SSH_KEY:-}" ]; then
    ssh -i "$DEPLOY_SSH_KEY" -o IdentitiesOnly=yes -o ServerAliveInterval=30 "$HOST" "$@"
  else
    ssh -o ServerAliveInterval=30 "$HOST" "$@"
  fi
}

step "Parity"
cd "$HERE/.."
[ -z "$(git status --porcelain)" ] || fail "the local tree has changes that are not committed"
git fetch -q origin "$BRANCH"
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"
[ "$LOCAL" = "$REMOTE" ] || fail "local HEAD $(git rev-parse --short HEAD) is not origin/$BRANCH $(git rev-parse --short "origin/$BRANCH"): push or pull first"
SERVER="$(remote "cd '$DIR' && git status --porcelain | wc -l | tr -d ' ' && git rev-parse HEAD")"
[ "$(echo "$SERVER" | sed -n 1p)" = "0" ] || fail "the server tree has local changes"
SERVER_HEAD="$(echo "$SERVER" | sed -n 2p)"
echo "local and origin/$BRANCH: $(git rev-parse --short HEAD)"
echo "server:                  $(echo "$SERVER_HEAD" | cut -c1-7)"

if [ -z "$CHECK_ONLY" ]; then
  if [ "$SERVER_HEAD" = "$LOCAL" ]; then
    echo "the server already has this commit: build and start run again"
  else
    git merge-base --is-ancestor "$SERVER_HEAD" "$LOCAL" 2>/dev/null || fail "the server commit is not an ancestor of $BRANCH: fix the server tree by hand"
    echo "commits to deploy:"
    git log --oneline "$SERVER_HEAD..$LOCAL" | sed 's/^/  /'
  fi
  step "Server"
  remote "cd '$DIR' && git pull -q --ff-only origin '$BRANCH' && sh deploy/remote-deploy.sh '$LOCAL' $RESTART_ALL"
fi

step "Verify from this machine"
# Names only: these three settings are public hostnames, not secrets.
NAMES="$(remote "cd '$DIR' && grep -E '^(PUBLIC_URL|CONTROL_DOMAIN|DERP_DOMAIN)=' .env")"
name() { echo "$NAMES" | grep "^$1=" | head -1 | cut -d= -f2-; }
PUBLIC_URL="$(name PUBLIC_URL)"
CONTROL="$(name CONTROL_DOMAIN)"
DERP="$(name DERP_DOMAIN)"
bad=0
expect() {
  code="$(curl -s -o /dev/null -m 20 -w '%{http_code}' "$2" || true)"
  if [ "$code" = "$1" ]; then echo "ok   $code $2"; else echo "FAIL $code $2 (expected $1)"; bad=1; fi
}
expect 200 "$PUBLIC_URL/health"
expect 200 "$PUBLIC_URL/"
if [ -n "$CONTROL" ]; then
  expect 200 "https://$CONTROL/key"
  expect 404 "https://$CONTROL/api/nodes"
  expect 404 "https://$CONTROL/health"
fi
[ -n "$DERP" ] && expect 200 "https://$DERP/derp/probe"
[ "$bad" = "0" ] || fail "a public check failed"
if [ -n "$CHECK_ONLY" ]; then echo "check only: nothing was changed"; else echo "deployed $(git rev-parse --short HEAD)"; fi
