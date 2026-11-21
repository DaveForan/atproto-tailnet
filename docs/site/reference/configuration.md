---
title: Configuration Reference
---

# Configuration Reference

All configuration comes from environment variables. A Zod schema in `src/config.ts` validates them at startup. If the configuration is not valid, the service exits immediately and shows a descriptive error.

## Core settings

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | `postgresql://atproto_tailnet:atproto_tailnet@localhost:5432/atproto_tailnet` | PostgreSQL connection string |
| `SESSION_SECRET` | Yes | `dev-secret-change-me` | Session signing key. See [Secret strength rules](#secret-strength-rules) |
| `PORT` | No | `3000` | HTTP listen port for the TypeScript service |
| `PUBLIC_URL` | Yes (production) | `http://localhost:3000` | Public URL of the dashboard, for example `https://tailnets.example.com`. For local development use `http://127.0.0.1:3000`, because AT Proto OAuth redirects loopback clients to the IP address |
| `BASE_DOMAIN` | No | `ts.localhost` | Wildcard domain for tailnet addresses (`<address>.<BASE_DOMAIN>`), used in join and board links and by legacy login servers |
| `CONTROL_DOMAIN` | No | *(none)* | Coordinator mode: hostname of the one login server that all tailnets use, for example `control.yourdomain.com`. It needs a DNS A record. It must not be `BASE_DOMAIN` or a name under it |
| `TAILNET_DNS_UPSTREAM` | No | *(none)* | Coordinator mode: IP addresses (comma-separated) of the resolvers that devices use for names under `BASE_DOMAIN` that have no record. Empty: devices use their own resolvers |
| `DERP_DOMAIN` | No | *(none)* | Docker stack: public hostname of the built-in DERP relay (sets `COORD_DERP_HOSTNAME`). It needs a DNS A record and open UDP port 3478 |
| `TENANT_PUBLIC_PORT` | No | *(from URL)* | Port in the device connection URLs. Set to `8180` for local dev with Caddy. Leave it unset in production |
| `TRUST_PROXY` | Behind a proxy | `0` | Number of reverse-proxy hops to trust for `X-Forwarded-*` (0 to 5). Set `1` behind Caddy. Without it, the browser does not send the secure session cookie and sign-in fails. All rate limits also see one client. The Docker Compose files set `1` |
| `LOG_LEVEL` | No | `info` | Pino log level: `debug`, `info`, `warn`, `error` |

## Instance operators

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPERATOR_DIDS` | Yes (production) | *(empty)* | Comma-separated DIDs of the instance operators, for example `did:plc:abc123,did:web:example.com`. Each entry must start with `did:` |

Only operators get a tailnet at sign-in. Operators can also designate "tailnet creators" in the **Instance** tab. Each other person who signs in sees only their invitations and, if available, a **Request to join** button for the default tailnet.

If `OPERATOR_DIDS` is empty on a production instance, the service logs a loud warning. It still starts, but nobody can create a tailnet. A change to the list needs a restart.

Set `OPERATOR_DIDS` before the first sign-in. To find your DID, run this command:

```bash
curl "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=you.bsky.social"
```

## Coordinator mode

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `COORDINATOR_URL` | No | --- | Enables coordinator mode when set. URL of the Rust coordinator (e.g., `http://coordinator:9443`). Must use `http` or `https` |
| `COORDINATOR_API_KEY` | When `COORDINATOR_URL` set | --- | Bearer token for the coordinator admin API. Must be equal to `COORD_ADMIN_KEY` on the coordinator |

## Legacy Headscale mode

The service uses these variables only when `COORDINATOR_URL` is **not** set:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HEADSCALE_IMAGE` | No | `headscale/headscale:0.29.1` | Docker image for tenant Headscale containers |
| `HEADSCALE_PORT_RANGE_START` | No | `10001` | First port in the allocation pool |
| `HEADSCALE_PORT_RANGE_END` | No | `10100` | Last port (inclusive) |
| `HEADSCALE_DATA_DIR` | No | `./data/headscale` | Host directory for persistent Headscale data |
| `HEADSCALE_NETWORK` | No | *(unset)* | Docker network shared with Caddy. The example files set `atproto-tailnet-tenants`. When it is unset, Caddy must run on the host |

## Authentication

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ATPROTO_PRIVATE_KEY` | Production only | --- | ES256 (P-256) private key for AT Proto OAuth client authentication. Use a JWK on one line. A PKCS#8 PEM also works. Not needed for local development: a loopback deployment uses a loopback client without a key |

To generate the JWK, run this command in a checkout after `npm install`:

```bash
node --input-type=module -e "import {generateKeyPair,exportJWK} from 'jose'; const {privateKey}=await generateKeyPair('ES256',{extractable:true}); console.log(JSON.stringify({...await exportJWK(privateKey),alg:'ES256'}))"
```

Put the output in `.env` between single quotes:

```ini
ATPROTO_PRIVATE_KEY='{"kty":"EC","crv":"P-256","x":"...","y":"...","d":"...","alg":"ES256"}'
```

The service publishes the public part at `/.well-known/jwks.json`. For a Docker-only server, see [First deployment on DigitalOcean](https://github.com/DaveForan/atproto-tailnet/blob/master/docs/deployment.md#first-deployment-on-digitalocean).

## Notifications

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WEBHOOK_ALLOW_PRIVATE` | No | `false` | Lets notification webhooks use plain `http` and private or loopback addresses |

By default, a webhook URL must use `https` and resolve to a public address. The service checks the address again when it connects. It does not follow redirects.

Set `WEBHOOK_ALLOW_PRIVATE=true` only for single-organisation self-hosting, for example when ntfy or Gotify runs on your private network. Do not set it on a multi-tenant instance. With this setting, each tenant admin can make the service send requests to internal hosts.

## Federation

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FEDERATION_ENABLED` | No | `false` | Turns on federation (links between tailnets). Keep it off |
| `FEDERATION_KEY_ENCRYPTION_KEY` | Recommended | --- | 64 hex characters (32 bytes). AES-256-GCM key that encrypts collective signing keys at rest. Without it, the service stores these keys without encryption. Collective keys also sign credentials, so set it even when federation is off |

Federation is off by default. The code exists, but links carry no traffic in the coordinator stack:

- The federation data plane needs Docker (Headscale mode).
- Cross-instance traffic is not implemented.

When `FEDERATION_ENABLED` is not `true`, the federation and traversal API paths return 404. The broker does not start. The dashboard hides the **Federation** and **Traversal Policy** tabs. The service still serves collective DID documents for credentials.

## Secret strength rules

The service and the coordinator refuse to start with a weak secret. These rules apply to each deployment that does not use a loopback `PUBLIC_URL`:

| Secret | Rule |
|--------|------|
| `SESSION_SECRET` | At least 32 characters. Must not contain `change-me` or `changeme` |
| `COORDINATOR_API_KEY` | At least 32 characters. Must not contain `change-me` or `changeme` |
| `COORD_ADMIN_KEY` (coordinator) | At least 32 characters. Must not contain `change-me` or `changeme`. This rule applies always, also in development |
| `FEDERATION_KEY_ENCRYPTION_KEY` | Exactly 64 hex characters |

To generate a secret, run `openssl rand -hex 32`. The DigitalOcean setup script (`deploy/digitalocean/droplet-setup.sh`) generates `SESSION_SECRET`, `POSTGRES_PASSWORD`, `COORDINATOR_API_KEY` and `FEDERATION_KEY_ENCRYPTION_KEY` for you.

## Caddy and TLS

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CADDY_ADMIN_URL` | No | `http://localhost:2019` | Caddy admin API URL for dynamic route management |
| `TLS_STRATEGY` | No | `on-demand` | TLS certificate strategy. See [TLS strategies](#tls-strategies) below |
| `APP_DOMAIN` | Yes (production) | `tailnets.example.com` | Domain of the dashboard, the API and `/mcp`. Caddy uses it. The service does not derive it from `PUBLIC_URL`, so keep both equal |
| `CADDY_DNS_PLUGINS` | When DNS-01 | --- | Space-separated Go module paths for Caddy DNS modules (e.g., `github.com/caddy-dns/route53`). Docker Compose builds Caddy with these modules |
| `CADDY_CERTS_DIR` | When `manual` | `./caddy/certs` | Folder with `wildcard.pem` and `wildcard.key`. Compose mounts it read-only at `/etc/caddy/certs` |
| `CADDY_HTTP_PORT` | No | `80` | Host port for HTTP (coordinator compose file) |
| `CADDY_HTTPS_PORT` | No | `443` | Host port for HTTPS, TCP and UDP (coordinator compose file) |

### TLS strategies

The `TLS_STRATEGY` variable selects how Caddy obtains certificates for tenant subdomains. Each strategy is a directory in `caddy/tls-strategies/`. The directory contains the snippets `global.caddy` and `site.caddy`. The production Caddyfile imports these snippets.

| Strategy | Type | DNS credentials | Caddy module needed | Notes |
|----------|------|-----------------|---------------------|-------|
| `on-demand` | Per-tenant certs | None | None | Default. Caddy issues individual certs on first connection. Needs the `/internal/tls-check` endpoint (built-in) |
| `cloudflare` | Wildcard | `CF_API_TOKEN` | `caddy-dns/cloudflare` | |
| `route53` | Wildcard | `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `caddy-dns/route53` | Instance roles also work (no key env vars) |
| `digitalocean` | Wildcard | `DO_AUTH_TOKEN` | `caddy-dns/digitalocean` | |
| `rfc2136` | Wildcard | `RFC2136_SERVER`, `RFC2136_KEY_NAME`, `RFC2136_KEY` | `caddy-dns/rfc2136` | BIND, Knot DNS, PowerDNS |
| `acmedns` | Wildcard | `ACMEDNS_SERVER_URL`, `ACMEDNS_USERNAME`, `ACMEDNS_PASSWORD`, `ACMEDNS_SUBDOMAIN` | `caddy-dns/acmedns` | One-time CNAME setup |
| `hetzner` | Wildcard | `HETZNER_API_TOKEN` | `caddy-dns/hetzner` | |
| `vultr` | Wildcard | `VULTR_API_KEY` | `caddy-dns/vultr` | |
| `manual` | Wildcard | None | None | Bring your own cert. Put it in `CADDY_CERTS_DIR` |

**Choosing a strategy:** `on-demand` is the simplest option. It needs no DNS provider API access and no extra Caddy modules. DNS-01 strategies issue a single wildcard certificate. This is faster for many tenants. `rfc2136` and `acmedns` work with self-hosted DNS and have no cloud provider dependencies. Use `manual` in environments that already have certificate management.

## Coordinator binary configuration

The Rust coordinator has its own configuration, separate from the TypeScript service. It reads a TOML file (the first CLI argument) and environment variables. Environment variables have priority.

### TOML file

```toml
listen = "127.0.0.1:9443"
domain = "mesh.local"
store_backend = "sqlite"      # "sqlite", "postgres", or "memory"
# sqlite_path = "./coordinator.db"
# database_url = "postgres://coord:coord@localhost/coordinator"
# derp_map_file = "/etc/coordinator/derp-map.json"
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `COORD_STORE_BACKEND` | *(required)* | Storage backend: `sqlite`, `postgres`, or `memory` (overrides TOML `store_backend`). There is no default. The Docker stack uses `postgres` |
| `COORD_LISTEN` | `127.0.0.1:9443` | Listen address (overrides TOML `listen`) |
| `COORD_ADMIN_KEY` | *(none)* | Admin API bearer token. When unset, the admin API is disabled and returns 503. A weak key stops the start (see [Secret strength rules](#secret-strength-rules)) |
| `COORD_CONTROL_KEY_PATH` | *(none)* | File for the Noise control key. The coordinator creates it at first start (32 bytes, hex). Without it, the coordinator uses a new key at each start and all clients must connect again. The Docker stack sets `/var/lib/coordinator/control.key` on the `coord_data` volume. Back it up |
| `COORD_SQLITE_PATH` | `coordinator.db` | SQLite database file path (used when backend = `sqlite`) |
| `COORD_DERP_HOSTNAME` | *(none)* | Public hostname of the built-in DERP relay. When set, the relay is region 1 of the default map and the STUN server starts |
| `COORD_STUN_LISTEN` | `0.0.0.0:3478` | UDP address of the STUN server. `off` disables it |
| `COORD_DERP_KEY_PATH` | `derp.key` next to the control key | File for the relay key. The coordinator creates it at first start |
| `COORD_GATEWAY_UDP_LISTEN` | *(none)* | UDP address of the gateway socket for direct paths (ADR-0029 phase 2), for example `0.0.0.0:41641`. Unset: the gateway uses the relay only |
| `COORD_GATEWAY_ENDPOINTS` | *(none)* | Public `ip:port` addresses of that socket, with commas between them (8 at most). Devices get them as the endpoints of the gateway |
| `COORD_DERP_MAP` | *(none)* | Path to JSON DERP map file (overrides TOML `derp_map_file`). It replaces the default map. Each tenant can override it from the dashboard |
| `COORD_FEDERATION_ENABLED` | `false` | Set `true` or `1` to serve the Rust federation endpoints and the broker. Keep it off. The TypeScript service is the authoritative federation endpoint |
| `DATABASE_URL` | *(none)* | PostgreSQL URL (required when backend = `postgres`) |
| `RUST_LOG` | `info` | Rust log filter (e.g., `coordinator=debug,coord_api=trace`) |

## Docker Compose files

| File | Mode | Use case |
|------|------|----------|
| `docker-compose.yml` | Legacy Headscale | Local development |
| `docker-compose.coordinator.dev.yml` | Coordinator | Local development |
| `docker-compose.coordinator.yml` | Coordinator | Production |
| `docker-compose.production.yml` | Legacy Headscale | Production |

## Caddyfiles

| File | Mode | Description |
|------|------|-------------|
| `Caddyfile` | Legacy dev | HTTP on `:80`, proxies to `host.docker.internal:3000` |
| `Caddyfile.coordinator` | Coordinator dev | HTTP on `:80`, proxies to `app:3000` |
| `Caddyfile.production` | Legacy prod | HTTPS with pluggable TLS strategy (imports from mounted `tls-strategy/`) |
| `Caddyfile.coordinator.production` | Coordinator prod | HTTPS with pluggable TLS strategy (imports from mounted `tls-strategy/`) |

All Caddyfiles name the server `tailnet_proxy`. The TypeScript service manages one route (`@id: tailnet_tenants`) through the Caddy admin API. This route sends tenant subdomains to the correct backend.

## npm scripts

| Script | Command | Description |
|--------|---------|-------------|
| `npm run dev` | `tsx watch --env-file=.env src/index.ts` | Development server with hot reload |
| `npm run build` | `tsc` | Compile TypeScript to `dist/` |
| `npm start` | `node dist/index.js` | Production server |
| `npx drizzle-kit generate` | --- | Generate database migration from schema changes |
| `npx drizzle-kit migrate` | --- | Apply pending migrations |
| `npx drizzle-kit studio` | --- | Open Drizzle Studio (database browser) |
| `npm run build:client` | `tsx esbuild.config.ts` | Build React dashboard to `public/js/` |
| `npm run dev:client` | `tsx esbuild.config.ts --watch` | Watch-mode dashboard rebuild |

## Production checklist

- [ ] `OPERATOR_DIDS` contains your DID. You set it before the first sign-in
- [ ] `SESSION_SECRET` is a unique random string, at least 32 characters
- [ ] `PUBLIC_URL` is your real HTTPS domain, and `APP_DOMAIN` is the same host
- [ ] `BASE_DOMAIN` has wildcard DNS that points to your server
- [ ] `COORDINATOR_API_KEY` / `COORD_ADMIN_KEY` are strong random values (matching)
- [ ] `FEDERATION_KEY_ENCRYPTION_KEY` is 64 random hex characters
- [ ] `ATPROTO_PRIVATE_KEY` is set (an ES256 JWK, see [Authentication](#authentication))
- [ ] `TRUST_PROXY=1` when the service is behind Caddy (the compose files set it)
- [ ] `FEDERATION_ENABLED` and `WEBHOOK_ALLOW_PRIVATE` are not set
- [ ] `TLS_STRATEGY` is set and the required env vars for that strategy are provided (see [TLS strategies](#tls-strategies))
- [ ] PostgreSQL has a strong password and is not exposed to the internet
- [ ] Caddy is the only service bound to ports 80/443
- [ ] `COORD_CONTROL_KEY_PATH` is on a persistent volume, and you back it up
