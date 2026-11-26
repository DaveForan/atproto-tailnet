---
title: Quickstart
---

# Quickstart

Start a local atproto-tailnet instance on your machine. This guide uses **coordinator mode** (recommended). Docker Compose runs PostgreSQL and Caddy, and the TypeScript service runs on the host.

## Prerequisites

- **Node.js 22+** and npm
- **Docker** and Docker Compose
- A **Bluesky account** (or any AT Protocol identity) to test the login

You do not need Rust. Docker builds the coordinator.

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
COORDINATOR_API_KEY=dev-coordinator-key-local-only-0000000000
OPERATOR_DIDS=did:plc:your-own-did
```

> `PUBLIC_URL` must use `127.0.0.1`, not `localhost`. The AT Protocol OAuth specification requires an IP address or a public domain.

> `OPERATOR_DIDS` must contain your own DID. Only operators get a tailnet at sign-in. To find your DID, run `curl "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=you.bsky.social"`.

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

You are an operator, so the platform provisions a tenant (your private mesh network) at the first sign-in. The dashboard shows the status change from "provisioning" to "running." This tailnet also becomes the default tailnet of the instance.

If you see "you aren't a member of any tailnet", your DID is not in `OPERATOR_DIDS`. Fix `.env`, restart `npm run dev`, then sign out and sign in again.

</li>
<li>

**Connect a device**

On the **Devices** page of the dashboard, generate a pre-authentication key under **Add a device**. The page shows the full command with the correct login server. Run it on the device that you want to connect. It looks like this:

```bash
tailscale up --login-server=http://<tailnet-address>.ts.localhost:8180 \
             --authkey=tskey-auth-XXXXX
```

When the device connects, it appears in the list on the same page.

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
- [Invite people](managing-your-network#inviting-members) by handle or DID
- [Connect Claude](mcp) to manage your tailnet from Claude
- [Manage your network](managing-your-network) --- roles, ACLs, devices
- [Configuration reference](../reference/configuration) for all options
