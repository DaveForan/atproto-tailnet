---
title: Quickstart
---

# Quickstart

Start a local atproto-tailnet instance on your machine. This guide uses **coordinator mode** (recommended). Docker Compose runs PostgreSQL and Caddy, and the TypeScript service runs on the host.

## Prerequisites

- **Node.js 22+** and npm
- **Docker** and Docker Compose
- **Rust 1.85+** and Cargo (for the coordinator)
- A **Bluesky account** (or any AT Protocol identity) to test the login

## Steps

<ol class="steps">
<li>

**Clone and configure**

```bash
git clone https://github.com/DaveForan/atproto-tailnet.git
cd atproto-tailnet
cp .env.example .env
```

Edit `.env` and set at least these variables:

```ini
DATABASE_URL=postgresql://atproto_tailnet:atproto_tailnet@localhost:5432/atproto_tailnet
SESSION_SECRET=change-me-to-something-random-at-least-32-chars
PUBLIC_URL=http://127.0.0.1:3000
BASE_DOMAIN=ts.localhost
COORDINATOR_URL=http://127.0.0.1:9443
COORDINATOR_API_KEY=dev-coordinator-key
```

> `PUBLIC_URL` must use `127.0.0.1`, not `localhost`. The AT Protocol OAuth specification requires an IP address or a public domain.

</li>
<li>

**Start infrastructure**

```bash
docker compose -f docker-compose.coordinator.dev.yml up -d
```

This command starts PostgreSQL on port 5432, the Rust coordinator on port 9443, and Caddy on port 8180. To verify, run:

```bash
curl http://127.0.0.1:9443/health
# {"status":"ok"}
```

</li>
<li>

**Install dependencies and run migrations**

```bash
npm install --include=dev
npm run build:client
npx drizzle-kit generate
npx drizzle-kit migrate
```

> If you set `NODE_ENV=production` globally on your system, you must use the `--include=dev` flag. Without the flag, npm does not install dev dependencies.

</li>
<li>

**Start the service**

```bash
npm run dev
```

The service starts on `http://127.0.0.1:3000`. The output shows this line:

```
{"level":30,"msg":"Server listening on port 3000"}
```

</li>
<li>

**Sign in**

Open `http://127.0.0.1:3000` in your browser. Enter your AT Protocol handle (for example, `you.bsky.social`) and click **Sign In**. The browser redirects you to your PDS for OAuth authorization. Then it returns you to your new dashboard.

On first login, the platform provisions a tenant (your private mesh network) automatically. The dashboard shows the status change from "provisioning" to "running."

</li>
<li>

**Connect a device**

In the **Devices** tab of the dashboard, click **Generate Auth Key** to receive a pre-authentication key. Then run this command on the device that you want to connect:

```bash
tailscale up --login-server=http://<your-tenant-slug>.ts.localhost:8180 \
             --authkey=tskey-auth-XXXXX
```

When the device connects, it appears in your Devices tab.

</li>
</ol>

## What runs after setup

After these steps, these components run:

| Component | Address | Purpose |
|-----------|---------|---------|
| TypeScript service | `127.0.0.1:3000` | React dashboard, API, OAuth, orchestration |
| Rust coordinator | `127.0.0.1:9443` | Mesh control plane (Noise IK, multi-tenant) |
| PostgreSQL | `127.0.0.1:5432` | Persistent storage |
| Caddy | `127.0.0.1:8180` | Reverse proxy, subdomain routing |

## Next steps

- [Deploy to production](coordinator) with TLS and a public domain
- [Set up federation](federation) to connect networks
- [Manage your network](managing-your-network) --- roles, ACLs, devices
- [Configuration reference](../reference/configuration) for all options
