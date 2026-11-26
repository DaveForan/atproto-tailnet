---
title: The Coordinator
---

# The Coordinator

The Rust mesh coordinator is a purpose-built, multi-tenant WireGuard control plane. It is the only control plane: one binary serves all tailnets. It handles the Tailscale client protocol natively, so standard Tailscale clients connect directly.

## Architecture

```
Tailscale clients ──► Caddy (TLS termination)
                         │
                         ├──► Coordinator (port 9443)
                         │      Noise IK handshake
                         │      Node registration
                         │      Streaming map updates
                         │      (tenant subdomains: /key, /ts2021, /health)
                         │
                         └──► TypeScript service (port 3000)
                                Web UI / API / MCP
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

This command starts the coordinator, PostgreSQL, and Caddy. Docker builds the coordinator from `coordinator/Dockerfile`. The coordinator starts with `COORD_ADMIN_KEY=dev-coordinator-key-local-only-0000000000`.

</li>
<li>

**Configure the service**

Make sure that your `.env` has these lines (`.env.example` contains them):

```ini
COORDINATOR_URL=http://localhost:9443
COORDINATOR_API_KEY=dev-coordinator-key-local-only-0000000000
```

The service refuses to start without both variables. Tenant provisioning creates tenants through the coordinator REST API. It does not launch Docker containers.

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
POSTGRES_PASSWORD=<random-string>
SESSION_SECRET=<random-string-at-least-32-chars>
PUBLIC_URL=https://yourdomain.com
BASE_DOMAIN=ts.yourdomain.com
COORDINATOR_URL=http://coordinator:9443
COORDINATOR_API_KEY=<generate-a-strong-key>
FEDERATION_KEY_ENCRYPTION_KEY=<64-hex-chars>
APP_DOMAIN=yourdomain.com
TLS_STRATEGY=on-demand
OPERATOR_DIDS=did:plc:your-own-did
ATPROTO_PRIVATE_KEY='{"kty":"EC","crv":"P-256",...}'
```

The compose file passes `COORDINATOR_API_KEY` to the coordinator as `COORD_ADMIN_KEY`. It also builds `DATABASE_URL` from the `POSTGRES_*` values, and it sets `TRUST_PROXY=1`. The app and the coordinator refuse keys that are shorter than 32 characters or that contain `change-me`.

For `ATPROTO_PRIVATE_KEY`, see [Authentication](../reference/configuration#authentication). For a full walkthrough, see [First deployment on DigitalOcean](https://github.com/DaveForan/atproto-tailnet/blob/master/docs/deployment.md#first-deployment-on-digitalocean).

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

- **coordinator** --- Rust binary on port 9443 (internal, non-root)
- **app** --- TypeScript service on port 3000 (internal, non-root)
- **postgres** --- PostgreSQL 17 with health checks, on the `internal` network only
- **caddy** --- TLS termination and routing on ports 80/443, on the `edge` network only

</li>
<li>

**Verify**

```bash
# Service health (dashboard domain)
curl https://yourdomain.com/health

# Key endpoint of the coordinator on a tenant subdomain (needed by Tailscale clients)
curl https://<slug>.ts.yourdomain.com/key
# {"publicKey":"mkey:...","legacyPublicKey":"mkey:..."}
```

Sign in as the operator before anyone else. Only operators get a tailnet at sign-in. The `/key` check works after your tailnet exists.

</li>
</ol>

## Coordinator configuration

The coordinator reads its configuration from a TOML file and from environment variables. You pass the TOML file as the first CLI argument. Environment variables have priority.

| Setting | TOML key | Env var | Default |
|---------|----------|---------|---------|
| Listen address | `listen` | `COORD_LISTEN` | `127.0.0.1:9443` |
| Mesh domain | `domain` | --- | `mesh.local` |
| Storage backend | `store_backend` | `COORD_STORE_BACKEND` | *(required)* |
| Admin API key | --- | `COORD_ADMIN_KEY` | *(none --- admin API disabled, 503)* |
| Control key file | --- | `COORD_CONTROL_KEY_PATH` | *(none --- new key at each start)* |
| Rust federation endpoints | --- | `COORD_FEDERATION_ENABLED` | `false` |
| SQLite path | `sqlite_path` | `COORD_SQLITE_PATH` | `coordinator.db` |
| PostgreSQL URL | `database_url` | `DATABASE_URL` | *(required when backend = postgres)* |
| Built-in DERP relay host | `derp_hostname` | `COORD_DERP_HOSTNAME` | *(none --- no relay region)* |
| STUN listen address | `stun_listen` | `COORD_STUN_LISTEN` | `0.0.0.0:3478` (`off` disables) |
| DERP relay key file | --- | `COORD_DERP_KEY_PATH` | `derp.key` next to the control key |
| DERP map file | `derp_map_file` | `COORD_DERP_MAP` | *(none)* |

### Storage backends

You must set `store_backend` explicitly (TOML key or `COORD_STORE_BACKEND` env var):

- **SQLite** (`sqlite`): A single-file database with no dependencies. Use it for standalone deployments and self-hosting. Set the path with `sqlite_path` or `COORD_SQLITE_PATH` (default: `coordinator.db`). It uses WAL mode for concurrent reads.
- **PostgreSQL** (`postgres`): Full PostgreSQL. Set the connection with `database_url` or `DATABASE_URL`. You must use it when the coordinator runs together with the TypeScript service (shared database). It runs migrations at startup.
- **Memory** (`memory`): The coordinator keeps all state in the process. The state is lost at restart. Use it only for development and testing.

All three backends support the core node/tenant store and the federation store (links, broker sessions, collective DIDs).

### Control key

Tailscale clients pin the Noise public key of the control server. The coordinator must keep the same key after a restart.

- Set `COORD_CONTROL_KEY_PATH` to a file on persistent storage. The coordinator creates the file at first start (32 bytes as hex).
- The Docker stack uses `/var/lib/coordinator/control.key` on the `coord_data` volume.
- Back up this file. If you lose it, every device must connect again.
- Without `COORD_CONTROL_KEY_PATH`, the coordinator makes a new key at each start and logs a warning.

### Tenant subdomains

Each tenant has the subdomain `<slug>.<BASE_DOMAIN>`. On a tenant subdomain, Caddy sends only these paths to the coordinator:

- `/key`
- `/ts2021`
- `/health`

Caddy returns 404 for all other paths and for unknown names. The admin API (`/api/*`) is never reachable through a tenant subdomain.

### Suspension

An instance operator can suspend a tailnet on the **Instance** page. The service then calls `PUT /api/tenants/{id}/suspended` on the coordinator. The suspension also applies to the sub-tailnets. While a tenant is suspended, its nodes cannot register or poll the map, and the coordinator ends their open map streams.

### DERP map

DERP (Designated Encrypted Relay for Packets) relays give fallback connectivity when direct peer-to-peer connections fail. The coordinator contains its own DERP relay and a STUN server. It does not use the relays of Tailscale.

- Set `COORD_DERP_HOSTNAME` (in the Docker stack: `DERP_DOMAIN`) to the public hostname of the relay, for example `derp.yourdomain.com`. The built-in relay then becomes region 1 of the default map. The hostname needs a DNS A record. Caddy sends `/derp` to the coordinator.
- Open UDP port 3478 for STUN. Devices use STUN to find a direct path, so that less traffic uses the relay.
- The relay serves only devices that are registered with this coordinator. It relays packets only between devices of one tailnet, or of a tailnet and its sub-tailnets. A removed device, or a device of a suspended tailnet, loses the relay in about one minute.
- If you set no relay hostname and no map file, the default map is empty and the coordinator logs a warning. Devices that cannot connect directly then cannot reach each other.

DERP configuration applies to one tenant at a time. There is no global DERP endpoint.

- Each tenant can add its own relay regions (IDs 900-999) under **Settings → Relays**. The service sends them to `PUT /api/tenants/{id}/derp` for that tenant only. Connected devices of that tenant get the new map at once.
- A tenant can also turn off the default map.
- The service database is the source of truth. The coordinator keeps the maps in memory. The service sends them again after a coordinator restart.

To change the default map for all tenants, create a JSON file:

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

### Subnet routes and exit nodes

A device advertises routes with `tailscale up --advertise-routes=...` or `--advertise-exit-node`. The coordinator reads them from `Hostinfo.RoutableIPs`. A route has no effect until somebody approves it:

1. Open **Settings → Routes** (the `manage_devices` permission is necessary).
2. Find the advertised route.
3. Select **Enable**. The service calls `POST /api/tenants/{id}/nodes/{node_id}/routes`.

**Disable** or **Delete** withdraws the approval. The device keeps the advertisement.

The coordinator also supports tag-based auto-approvers (`PUT /api/tenants/{id}/auto-approvers`). The service uses them only for federated routes. ACL `autoApprovers` are refused.

### ACL limits

The coordinator has no users, groups or tags. The service accepts only these ACL items:

- `accept` rules
- Sources and destinations that are `*`, an IP address, a CIDR, or a host alias
- `hosts` entries that are IP addresses or CIDRs

The service refuses a policy with `groups`, `tagOwners`, `autoApprovers` or user sources. It does not drop them without notice.

## Disconnect detection

The coordinator sends HTTP/2 PING frames to detect dead client sessions:

- **Keep-alive interval**: 30 seconds
- **Keep-alive timeout**: 90 seconds

If the H2 connection of a client drops (process killed, network down), the coordinator marks the node offline within ~90 seconds. Then it tells all peers through the streaming map update channel.

A graceful `tailscale down` keeps the Noise session open but the client stops its response to H2 PINGs. The timeout mechanism handles both crashes and graceful shutdowns.

## Admin API

When you set `COORD_ADMIN_KEY`, all `/api/*` endpoints need the header `Authorization: Bearer <key>`. The key must have 32 characters or more, and it must not contain `change-me`. When you do not set it, the admin API is disabled and returns 503. The health (`/health`), key (`/key`) and `/ts2021` endpoints are always public.

Only the TypeScript service must reach the admin API. The Docker stack does not publish port 9443.

The Rust federation endpoints (`/api/federation/messages/*`) exist only when `COORD_FEDERATION_ENABLED=true`. Keep it off. See [Federation](federation).

For the full endpoint list, see the [API reference](../reference/api).
