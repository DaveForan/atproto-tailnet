---
title: Coordinator Mode
---

# Coordinator Mode

The Rust mesh coordinator is a purpose-built, multi-tenant WireGuard control plane that replaces per-tenant Headscale Docker containers with a single binary. It handles the Tailscale client protocol natively, so standard Tailscale clients connect directly.

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

The coordinator uses the `Noise_IK_25519_ChaChaPoly_BLAKE2s` handshake protocol, the same Noise variant Tailscale uses. Clients connect to `POST /ts2021` to upgrade to a Noise-encrypted HTTP/2 session, then register via `POST /machine/register` and subscribe to peer updates via `POST /machine/map`.

## Local development

<ol class="steps">
<li>

**Start infrastructure**

```bash
docker compose -f docker-compose.coordinator.dev.yml up -d
```

This starts the coordinator, PostgreSQL, and Caddy. The coordinator is built from the `coordinator/Dockerfile` and runs with `COORD_ADMIN_KEY=dev-coordinator-key`.

</li>
<li>

**Configure the service**

Add to your `.env`:

```ini
COORDINATOR_URL=http://localhost:9443
COORDINATOR_API_KEY=dev-coordinator-key
```

When `COORDINATOR_URL` is set, the service uses the `CoordinatorApiClient` instead of `HeadscaleApiClient`. Tenant provisioning creates tenants via the coordinator REST API instead of launching Docker containers.

</li>
<li>

**Run the service**

```bash
npm install --include=dev
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

Generate keys:

```bash
# Admin/API key
openssl rand -hex 32

# Federation encryption key
openssl rand -hex 32
```

</li>
<li>

**Choose TLS strategy**

The `TLS_STRATEGY` env var selects how Caddy obtains certificates. The default `on-demand` needs no DNS credentials — Caddy issues per-tenant certs automatically. For DNS-01 wildcard strategies, set the strategy name and its required env vars (see `caddy/tls-strategies/` for per-strategy docs), plus build Caddy with the DNS module:

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

This launches:
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

The coordinator reads configuration from a TOML file (passed as the first CLI argument) and environment variables. Environment variables take precedence.

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

The coordinator requires an explicit `store_backend` setting (TOML key or `COORD_STORE_BACKEND` env var):

- **SQLite** (`sqlite`): Zero-dependency, single-file database. Recommended for standalone deployments and self-hosting. Configurable path via `sqlite_path` or `COORD_SQLITE_PATH` (default: `coordinator.db`). Uses WAL mode for concurrent reads.
- **PostgreSQL** (`postgres`): Full PostgreSQL via `database_url` or `DATABASE_URL`. Required when running alongside the TypeScript service (shared database). Runs migrations on startup.
- **Memory** (`memory`): All state in-process, lost on restart. For development and testing only.

All three backends support both the core node/tenant store and the federation store (links, broker sessions, collective DIDs).

### DERP map

DERP (Designated Encrypted Relay for Packets) relays provide fallback connectivity when direct peer-to-peer connections fail. By default, the coordinator uses Tailscale's public DERP infrastructure (region 1, `derp1.tailscale.com`).

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

Point to it with `derp_map_file` in the TOML or `COORD_DERP_MAP` env var.

## Disconnect detection

The coordinator uses HTTP/2 PING frames to detect dead client sessions:

- **Keep-alive interval**: 30 seconds
- **Keep-alive timeout**: 90 seconds

If a client's H2 connection drops (process killed, network down), the coordinator marks the node offline within ~90 seconds and notifies all peers via the streaming map update channel.

A graceful `tailscale down` keeps the Noise session alive but stops responding to H2 PINGs, so the timeout mechanism handles both crash and graceful shutdown cases.

## Admin API

When `COORD_ADMIN_KEY` is set, all `/api/*` endpoints require `Authorization: Bearer <key>`. The health (`/health`) and key (`/key`) endpoints are always public.

See the [API reference](../reference/api) for the full endpoint listing.
