---
title: Quickstart
---

# Quickstart

Get a local atproto-tailnet instance running on your machine. This guide uses **coordinator mode** (recommended) with Docker Compose for PostgreSQL and Caddy, and the TypeScript service running on the host.

## Prerequisites

- **Node.js 22+** and npm
- **Docker** and Docker Compose
- **Rust 1.85+** and Cargo (for the coordinator)
- A **Bluesky account** (or any AT Protocol identity) for testing login

## Steps

<ol class="steps">
<li>

**Clone and configure**

```bash
git clone https://github.com/DaveForan/atproto-tailnet.git
cd atproto-tailnet
cp .env.example .env
```

Edit `.env` and set at minimum:

```ini
DATABASE_URL=postgresql://atproto_tailnet:atproto_tailnet@localhost:5432/atproto_tailnet
SESSION_SECRET=change-me-to-something-random-at-least-32-chars
PUBLIC_URL=http://127.0.0.1:3000
BASE_DOMAIN=ts.localhost
COORDINATOR_URL=http://127.0.0.1:9443
COORDINATOR_API_KEY=dev-coordinator-key
```

> `PUBLIC_URL` must use `127.0.0.1`, not `localhost` --- the AT Protocol OAuth spec requires an IP or a public domain.

</li>
<li>

**Start infrastructure**

```bash
docker compose -f docker-compose.coordinator.dev.yml up -d
```

This starts PostgreSQL on port 5432, the Rust coordinator on port 9443, and Caddy on port 8180. Verify:

```bash
curl http://127.0.0.1:9443/health
# {"status":"ok"}
```

</li>
<li>

**Install dependencies and run migrations**

```bash
npm install --include=dev
npx drizzle-kit generate
npx drizzle-kit migrate
```

> If `NODE_ENV=production` is set globally on your system, the `--include=dev` flag is required for npm to install dev dependencies.

</li>
<li>

**Start the service**

```bash
npm run dev
```

The service starts on `http://127.0.0.1:3000`. You should see:

```
{"level":30,"msg":"Server listening on port 3000"}
```

</li>
<li>

**Sign in**

Open `http://127.0.0.1:3000` in your browser. Enter your AT Protocol handle (e.g., `you.bsky.social`) and click **Sign In**. You'll be redirected to your PDS for OAuth authorization, then back to your new dashboard.

On first login, a tenant (your private mesh network) is provisioned automatically. The dashboard shows its status cycling from "provisioning" to "running."

</li>
<li>

**Connect a device**

From the **Devices** tab in the dashboard, click **Generate Auth Key** to get a pre-authentication key. Then on the device you want to connect:

```bash
tailscale up --login-server=http://<your-tenant-slug>.ts.localhost:8180 \
             --authkey=tskey-auth-XXXXX
```

The device appears in your Devices tab once connected.

</li>
</ol>

## What's running

After these steps you have:

| Component | Address | Purpose |
|-----------|---------|---------|
| TypeScript service | `127.0.0.1:3000` | Web UI, API, OAuth, orchestration |
| Rust coordinator | `127.0.0.1:9443` | Mesh control plane (Noise IK, multi-tenant) |
| PostgreSQL | `127.0.0.1:5432` | Persistent storage |
| Caddy | `127.0.0.1:8180` | Reverse proxy, subdomain routing |

## Next steps

- [Deploy to production](coordinator) with TLS and a public domain
- [Set up federation](federation) to connect networks
- [Manage your network](managing-your-network) --- roles, ACLs, devices
- [Configuration reference](../reference/configuration) for all options
