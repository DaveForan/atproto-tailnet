# Deploying atproto-tailnet on Railway

## Important limitation

**Docker socket access is not available on Railway.** Railway runs containers in
an isolated environment without access to the host Docker daemon. Since
atproto-tailnet manages per-tenant Headscale containers via the Docker socket,
the core orchestration functionality will not work on Railway alone.

### Workarounds

1. **External Docker host** -- Run Headscale containers on a separate VPS and
   configure the app to connect to a remote Docker daemon over TCP/TLS. This
   requires modifying `src/orchestrator/headscale.ts` to accept a
   `DOCKER_HOST` environment variable instead of the local socket.

2. **Railway + companion VPS** -- Deploy the app and Postgres on Railway for the
   web tier, but point `DOCKER_HOST` at a cheap VPS (Hetzner, DigitalOcean
   Droplet) that handles Headscale containers.

3. **Docker-in-Docker** -- Railway does not officially support DinD. If they add
   it in the future, mount the inner socket to the app container.

If none of these options work for your setup, consider deploying to a
DigitalOcean Droplet or AWS EC2 instance instead (see `deploy/digitalocean/` and
`deploy/aws/`).

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

Railway provisions a managed Postgres instance and injects `DATABASE_URL`
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

Railway handles TLS termination for the primary domain. For wildcard subdomains
(`*.ts.yourdomain.com`), you will still need Caddy or another proxy that
supports wildcard certificates, running externally.

## Caddy and wildcard TLS

Railway does not support wildcard TLS certificates natively. For production with
tenant subdomains, you need one of:

- An external Caddy or nginx instance that terminates TLS for `*.ts.yourdomain.com`
  and proxies to the Railway app
- Cloudflare proxy with wildcard DNS rules

## Cost estimate

- **Starter plan**: ~$5/month for the app + included Postgres
- **Pro plan**: $20/month base + usage-based compute and database

## Healthcheck

The app exposes `GET /health` which returns `200 OK` when the service is ready.
Railway uses this for zero-downtime deploys.
