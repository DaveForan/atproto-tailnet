---
title: Coordinator Mode
---

# Coordinator Mode

The Rust mesh coordinator is a purpose-built, multi-tenant WireGuard control plane. It replaces the Headscale Docker containers of each tenant with one binary. It handles the Tailscale client protocol natively, so standard Tailscale clients connect directly.

## Architecture

```
Tailscale clients ──► Caddy (TLS termination)
                         │
                         ├──► Coordinator (port 9443)
                         │      Noise IK handshake
                         │      Node registration
                         │      Streaming map updates
                         │      Federation broker
                         │
                         └──► TypeScript service (port 3000)
                                Web UI / API
                                OAuth
                                Orchestration
                                │
                                └──► PostgreSQL
```

The coordinator uses the `Noise_IK_25519_ChaChaPoly_BLAKE2s` handshake protocol. This is the same Noise variant that Tailscale uses. Clients connect to `POST /ts2021` to upgrade to a Noise-encrypted HTTP/2 session. Then they register with `POST /machine/register` and subscribe to peer updates with `POST /machine/map`.

## Local development

<ol class="steps">
<li>

**Start infrastructure**

```bash
docker compose -f docker-compose.coordinator.dev.yml up -d
```

This command starts the coordinator, PostgreSQL, and Caddy. Docker builds the coordinator from `coordinator/Dockerfile`. The coordinator starts with `COORD_ADMIN_KEY=dev-coordinator-key`.

</li>
<li>

**Configure the service**

Add these lines to your `.env`:

```ini
COORDINATOR_URL=http://localhost:9443
COORDINATOR_API_KEY=dev-coordinator-key
```

When you set `COORDINATOR_URL`, the service uses the `CoordinatorApiClient` and not the `HeadscaleApiClient`. Tenant provisioning creates tenants through the coordinator REST API. It does not launch Docker containers.

</li>
<li>

**Run the service**

```bash
npm install --include=dev
npm run build:client
npx drizzle-kit migrate
npm run dev
```

</li>
</ol>

## Production deployment

### Prerequisites

- A server with Docker and Docker Compose
- A domain with wildcard DNS (e.g., `*.ts.yourdomain.com`)
- A TLS strategy for wildcard certificates (see [TLS strategies](../reference/configuration.md#tls-strategies))

### Steps

<ol class="steps">
<li>

**Configure environment**

```bash
cp .env.coordinator.example .env
```

Edit `.env` with your production values:

```ini
DATABASE_URL=postgresql://coord:secure-password@postgres:5432/coordinator
SESSION_SECRET=<random-string-at-least-32-chars>
PUBLIC_URL=https://yourdomain.com
BASE_DOMAIN=ts.yourdomain.com
COORDINATOR_URL=http://coordinator:9443
COORDINATOR_API_KEY=<generate-a-strong-key>
COORD_ADMIN_KEY=<same-key-as-above>
FEDERATION_KEY_ENCRYPTION_KEY=<64-hex-chars>
APP_DOMAIN=yourdomain.com
TLS_STRATEGY=on-demand
```

Generate the keys:

```bash
# Admin/API key
openssl rand -hex 32

# Federation encryption key
openssl rand -hex 32
```

</li>
<li>

**Choose a TLS strategy**

The `TLS_STRATEGY` env var selects how Caddy obtains certificates. The default `on-demand` strategy does not need DNS credentials. Caddy issues a certificate for each tenant automatically. For DNS-01 wildcard strategies, set the strategy name and its required env vars. The `caddy/tls-strategies/` directory has the documentation for each strategy. You must also build Caddy with the DNS module:

```ini
TLS_STRATEGY=route53
CADDY_DNS_PLUGINS=github.com/caddy-dns/route53
AWS_REGION=us-east-1
```

</li>
<li>

**Start the stack**

```bash
docker compose -f docker-compose.coordinator.yml up -d
```

This command starts these services:
- **coordinator** --- Rust binary on port 9443 (internal)
- **app** --- TypeScript service on port 3000 (internal)
- **postgres** --- PostgreSQL 17 with health checks
- **caddy** --- TLS termination and routing on ports 80/443

</li>
<li>

**Verify**

```bash
# Coordinator health
curl https://yourdomain.com/health
# {"status":"ok"}

# Key endpoint (public, needed by Tailscale clients)
curl https://yourdomain.com/key
# {"publicKey":"mkey:...","legacyPublicKey":"mkey:..."}
```

</li>
</ol>

## Coordinator configuration

The coordinator reads its configuration from a TOML file and from environment variables. You pass the TOML file as the first CLI argument. Environment variables have priority.

| Setting | TOML key | Env var | Default |
|---------|----------|---------|---------|
| Listen address | `listen` | `COORD_LISTEN` | `127.0.0.1:9443` |
| Mesh domain | `domain` | --- | `mesh.local` |
| Storage backend | `store_backend` | `COORD_STORE_BACKEND` | *(required)* |
| Admin API key | --- | `COORD_ADMIN_KEY` | *(none --- auth disabled)* |
| SQLite path | `sqlite_path` | `COORD_SQLITE_PATH` | `coordinator.db` |
| PostgreSQL URL | `database_url` | `DATABASE_URL` | *(required when backend = postgres)* |
| DERP map file | `derp_map_file` | `COORD_DERP_MAP` | *(built-in Tailscale DERP)* |

### Storage backends

You must set `store_backend` explicitly (TOML key or `COORD_STORE_BACKEND` env var):

- **SQLite** (`sqlite`): A single-file database with no dependencies. Use it for standalone deployments and self-hosting. Set the path with `sqlite_path` or `COORD_SQLITE_PATH` (default: `coordinator.db`). It uses WAL mode for concurrent reads.
- **PostgreSQL** (`postgres`): Full PostgreSQL. Set the connection with `database_url` or `DATABASE_URL`. You must use it when the coordinator runs together with the TypeScript service (shared database). It runs migrations at startup.
- **Memory** (`memory`): The coordinator keeps all state in the process. The state is lost at restart. Use it only for development and testing.

All three backends support the core node/tenant store and the federation store (links, broker sessions, collective DIDs).

### DERP map

DERP (Designated Encrypted Relay for Packets) relays give fallback connectivity when direct peer-to-peer connections fail. By default, the coordinator uses the public DERP infrastructure of Tailscale (region 1, `derp1.tailscale.com`).

To use self-hosted DERP relays, create a JSON file:

```json
{
  "Regions": {
    "900": {
      "RegionID": 900,
      "RegionCode": "myrelay",
      "RegionName": "My Relay",
      "Nodes": [{
        "Name": "900a",
        "RegionID": 900,
        "HostName": "derp.yourdomain.com",
        "STUNPort": 3478,
        "DERPPort": 443
      }]
    }
  }
}
```

Set `derp_map_file` in the TOML or the `COORD_DERP_MAP` env var to the path of this file.

## Disconnect detection

The coordinator sends HTTP/2 PING frames to detect dead client sessions:

- **Keep-alive interval**: 30 seconds
- **Keep-alive timeout**: 90 seconds

If the H2 connection of a client drops (process killed, network down), the coordinator marks the node offline within ~90 seconds. Then it tells all peers through the streaming map update channel.

A graceful `tailscale down` keeps the Noise session open but the client stops its response to H2 PINGs. The timeout mechanism handles both crashes and graceful shutdowns.

## Admin API

When you set `COORD_ADMIN_KEY`, all `/api/*` endpoints need the header `Authorization: Bearer <key>`. The health (`/health`) and key (`/key`) endpoints are always public.

For the full endpoint list, see the [API reference](../reference/api).
