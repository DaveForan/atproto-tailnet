# Deploying atproto-tailnet on Railway

## Important limitation

**This guide deploys the web tier only.** The service needs the Rust
coordinator (`COORDINATOR_URL`, `COORDINATOR_API_KEY`) and refuses to start
without it. Devices also need a proxy for the tenant wildcard subdomains.
This guide does not set them up. You must run them yourself.

The recommended path is a single VPS with `docker-compose.coordinator.yml`. See
`deploy/digitalocean/`, `deploy/hetzner/`, `deploy/vultr/`, or `deploy/aws/`.

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
# The coordinator you run yourself (key = its COORD_ADMIN_KEY)
railway variables set COORDINATOR_URL="http://your-coordinator-host:9443"
railway variables set COORDINATOR_API_KEY='<your coordinator admin key>'
railway variables set LOG_LEVEL="info"

# The Railway platform proxy is in front of the app
railway variables set TRUST_PROXY="1"

# Instance operators (comma-separated DIDs); set before the first sign-in
railway variables set OPERATOR_DIDS="did:plc:your-own-did"

# AT Proto OAuth (production sign-in fails without it)
railway variables set ATPROTO_PRIVATE_KEY='<one-line ES256 JWK>'
```

Notes on these variables:

- `TRUST_PROXY=1` is necessary because the Railway proxy is in front of the app. Sign-in needs it for the secure session cookie.
- `SESSION_SECRET` must have 32 or more characters and must not contain `change-me` or `changeme`. If it does, the app does not start.
- `OPERATOR_DIDS` controls who gets a tailnet. Only operators, and the "tailnet creators" that an operator designates, get one. All other users see a "no access" view with their invitations and "Request to join" for the default tailnet. If `OPERATOR_DIDS` is empty, nobody can create a tailnet.
- Do not set `FEDERATION_ENABLED`. Federation is off by default.

To find your DID, use this command:

```sh
curl "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=you.bsky.social"
```

To generate `ATPROTO_PRIVATE_KEY`, run this command in a checkout after `npm install` (Node 22):

```sh
node --input-type=module -e "import {generateKeyPair,exportJWK} from 'jose'; const {privateKey}=await generateKeyPair('ES256',{extractable:true}); console.log(JSON.stringify({...await exportJWK(privateKey),alg:'ES256'}))"
```

The output is a one-line ES256 (P-256) private JWK that starts with `{`. A PKCS8 PEM also works, but it has many lines, so use the JWK.

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

After the first deploy, the operator must sign in first.
