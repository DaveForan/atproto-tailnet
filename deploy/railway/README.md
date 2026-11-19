# Deploying atproto-tailnet on Railway

## Important limitation

**Docker socket access is not available on Railway.** Railway runs containers in
an isolated environment. The containers cannot access the host Docker daemon.
atproto-tailnet manages the Headscale container of each tenant through the
Docker socket. Because of this, the core orchestration function does not work on
Railway alone.

### Workarounds

1. **External Docker host** -- Run the Headscale containers on a separate VPS.
   Configure the app to connect to a remote Docker daemon over TCP/TLS. You must
   change `src/orchestrator/headscale.ts` so that it accepts a `DOCKER_HOST`
   environment variable instead of the local socket.

2. **Railway + companion VPS** -- Deploy the app and Postgres on Railway for the
   web tier. Point `DOCKER_HOST` at a low-cost VPS (Hetzner or DigitalOcean
   Droplet) that runs the Headscale containers.

3. **Docker-in-Docker** -- Railway does not officially support DinD. If Railway
   adds support in the future, mount the inner socket to the app container.

If none of these options work for your setup, deploy to a DigitalOcean Droplet
or an AWS EC2 instance instead (see `deploy/digitalocean/` and `deploy/aws/`).

## Setup (web tier only)

### 1. Create the project

```sh
# Install Railway CLI
npm install -g @railway/cli
railway login

# Initialize project
railway init
```

### 2. Add PostgreSQL

```sh
railway add --plugin postgresql
```

Railway creates a managed Postgres instance and sets `DATABASE_URL`
automatically.

### 3. Set environment variables

```sh
railway variables set SESSION_SECRET="$(openssl rand -hex 32)"
railway variables set PUBLIC_URL="https://your-app.up.railway.app"
railway variables set BASE_DOMAIN="ts.yourdomain.com"
railway variables set HEADSCALE_IMAGE="headscale/headscale:0.29.1"
railway variables set HEADSCALE_PORT_RANGE_START="10001"
railway variables set HEADSCALE_PORT_RANGE_END="10100"
railway variables set LOG_LEVEL="info"

# If using external Docker host:
# railway variables set DOCKER_HOST="tcp://your-vps-ip:2376"
# railway variables set DOCKER_TLS_VERIFY="1"

# AT Proto OAuth (production)
# railway variables set ATPROTO_PRIVATE_KEY='<ES256 JWK>'
```

### 4. Deploy

Copy `railway.toml` to the project root (or deploy from this directory):

```sh
cp deploy/railway/railway.toml ./railway.toml
railway up
```

### 5. Custom domain

```sh
railway domain add your-app.yourdomain.com
```

Railway terminates TLS for the primary domain. For wildcard subdomains
(`*.ts.yourdomain.com`), you still need Caddy or another proxy that supports
wildcard certificates. This proxy must run externally.

## Caddy and wildcard TLS

Railway does not support wildcard TLS certificates natively. For production with
tenant subdomains, you need one of these options:

- An external Caddy or nginx instance that terminates TLS for `*.ts.yourdomain.com`
  and proxies to the Railway app
- A Cloudflare proxy with wildcard DNS rules

## Cost estimate

- **Starter plan**: ~$5/month for the app + included Postgres
- **Pro plan**: $20/month base + compute and database costs based on use

## Healthcheck

The app has a `GET /health` endpoint. It returns `200 OK` when the service is ready.
Railway uses this endpoint for deploys without downtime.
