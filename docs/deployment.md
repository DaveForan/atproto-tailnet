# Deployment Guide

## Overview

atproto-tailnet supports two control-plane modes:

1. **Coordinator mode** (recommended): The Rust mesh coordinator does all
   Tailscale control-plane operations. It does not need the Docker socket.
   The coordinator, the TS service, and PostgreSQL can run as containers on
   any platform.

2. **Legacy Headscale mode**: This mode uses one Headscale Docker container
   for each tenant. The app manages the containers through the Docker socket.
   You must control the host.

### Requirements

#### Coordinator mode (recommended)

| Requirement | Details |
|-------------|---------|
| Runtime | Node.js 22+ |
| Database | PostgreSQL 16+ |
| Coordinator | Rust binary (`coordinator/`) or coordinator Docker image |
| Reverse proxy | Caddy 2 with admin API for dynamic subdomain routing |
| Ports | 80, 443 (Caddy) on the host. The app (3000) and the coordinator (9443) are internal to Docker |
| DNS | Wildcard record `*.ts.yourdomain.com` that points to the host |
| TLS | Caddy provisions certificates automatically through a pluggable strategy |

#### Legacy Headscale mode

| Requirement | Details |
|-------------|---------|
| Runtime | Node.js 22+ |
| Database | PostgreSQL 16+ |
| Docker socket | `/var/run/docker.sock` — the app uses it to manage Headscale containers |
| Reverse proxy | Caddy 2 with admin API for dynamic subdomain routing |
| Ports | 80, 443 (Caddy), 3000 (app), 10001-10100 (Headscale tenants) |
| Persistent storage | `./data/headscale/` — tenant configs and SQLite DBs |
| DNS | Wildcard record `*.ts.yourdomain.com` that points to the host |
| TLS | Caddy provisions certificates automatically through a pluggable strategy |

### Platform comparison

| Platform | Docker socket | Coordinator mode | Headscale mode |
|----------|:---:|:---:|:---:|
| EC2 / Droplet / VPS | Yes | Full stack | Full stack |
| Railway | No | Full stack | Web tier only |
| DO App Platform | No | Full stack | Web tier only |
| AWS ECS Fargate | No | Full stack | Web tier only |

---

## Environment variables

All configuration goes through `src/config.ts`, which Zod validates. The app
does not start in production if `SESSION_SECRET` or `COORDINATOR_API_KEY` is
weak (shorter than 32 characters, or a `change-me` placeholder). The
coordinator applies the same rule to `COORD_ADMIN_KEY`. For the full list, see
the [configuration reference](site/reference/configuration.md).

| Variable | Required | Default | Description |
|----------|:---:|---------|-------------|
| `DATABASE_URL` | Yes | `postgresql://atproto_tailnet:atproto_tailnet@localhost:5432/atproto_tailnet` | PostgreSQL connection string |
| `SESSION_SECRET` | Yes | -- | Session signing key (>= 32 chars in production) |
| `PORT` | No | `3000` | HTTP listen port |
| `PUBLIC_URL` | Yes | `http://localhost:3000` | Public URL (the app uses it in OAuth callbacks) |
| `BASE_DOMAIN` | Yes | `ts.localhost` | Base domain for tenant subdomains |
| `HEADSCALE_IMAGE` | No | `headscale/headscale:0.29.1` | Docker image for Headscale containers |
| `HEADSCALE_PORT_RANGE_START` | No | `10001` | First port in the Headscale allocation pool |
| `HEADSCALE_PORT_RANGE_END` | No | `10100` | Last port in the Headscale allocation pool |
| `HEADSCALE_DATA_DIR` | No | `./data/headscale` | Persistent storage for tenant Headscale data |
| `CADDY_ADMIN_URL` | No | `http://localhost:2019` | Caddy admin API endpoint |
| `LOG_LEVEL` | No | `info` | Pino log level (`debug`, `info`, `warn`, `error`) |
| `ATPROTO_PRIVATE_KEY` | Prod | -- | ES256 JWK for AT Proto OAuth (required for production) |
| `TLS_STRATEGY` | No | `on-demand` | TLS certificate strategy (see `caddy/tls-strategies/`) |
| `COORDINATOR_URL` | Coord | -- | URL of the Rust coordinator (e.g. `http://coordinator:9443`) |
| `COORDINATOR_API_KEY` | Coord | -- | Bearer token for the coordinator admin API (required when you set `COORDINATOR_URL`) |
| `APP_DOMAIN` | Yes | -- | Domain of the dashboard, the API and `/mcp`. Caddy uses it. The app does not derive it from `PUBLIC_URL` |
| `TRUST_PROXY` | Behind a proxy | `0` | Reverse-proxy hops to trust. Must be `1` behind Caddy, or sign-in fails. The compose files set it |
| `CADDY_DNS_PLUGINS` | DNS-01 | -- | Caddy DNS module for your `TLS_STRATEGY`, for example `github.com/caddy-dns/digitalocean`. Add `@version` to pin a version. `Dockerfile.caddy` pins `github.com/caddy-dns/digitalocean` when you give no version |
| `CADDY_CERTS_DIR` | Manual | `./caddy/certs` | Folder with `wildcard.pem` and `wildcard.key` for `TLS_STRATEGY=manual` |
| `WEBHOOK_ALLOW_PRIVATE` | No | `false` | Set `true` only for single-organisation self-hosting. It lets notification webhooks reach private addresses |
| `OPERATOR_DIDS` | Yes (production) | -- | Comma-separated DIDs of the instance operators, for example `did:plc:abc123`. Only operators (and the "tailnet creators" they designate) get a tailnet; everyone else who signs in sees invitations or can request to join the default tailnet. Operators get the operator API (`/api/operator/*`). If it is empty the app logs a loud warning and nobody can create a tailnet |
| `FEDERATION_ENABLED` | No | `false` | Turns on federation (links between tailnets). Keep it off. The federation data plane needs Docker (Headscale mode), and cross-instance traffic is not implemented. Links carry no traffic in the coordinator stack |
| `FEDERATION_KEY_ENCRYPTION_KEY` | Recommended | -- | 64 hex characters. Encrypts collective signing keys at rest |

#### Coordinator-side env vars (Rust binary)

| Variable | Required | Default | Description |
|----------|:---:|---------|-------------|
| `COORD_LISTEN` | No | `0.0.0.0:9443` | Coordinator listen address |
| `COORD_ADMIN_KEY` | Yes | -- | Bearer token for the admin API (must match `COORDINATOR_API_KEY` above). At least 32 characters. When unset, the admin API returns 503 |
| `COORD_STORE_BACKEND` | Yes | -- | Storage backend: `memory`, `postgres`, or `sqlite` |
| `COORD_SQLITE_PATH` | SQLite | `coordinator.db` | Path to the SQLite database |
| `DATABASE_URL` | PG | -- | PostgreSQL connection string (when you use the postgres backend) |
| `COORD_CONTROL_KEY_PATH` | Yes | -- | File that holds the Noise control key. The coordinator creates it at first start. Keep it on a persistent volume. If the key changes, all clients must reconnect |
| `COORD_DERP_MAP` | No | -- | Path to the default DERP map JSON file. Each tenant can override it from the dashboard |
| `COORD_FEDERATION_ENABLED` | No | `false` | Serves the Rust federation endpoints. Keep it off |

### Production `.env` example (coordinator mode)

```sh
DATABASE_URL=postgresql://atproto_tailnet:strong-password@postgres:5432/atproto_tailnet
SESSION_SECRET=a1b2c3d4e5f6...   # openssl rand -hex 32
PORT=3000
PUBLIC_URL=https://tailnets.yourdomain.com
BASE_DOMAIN=ts.yourdomain.com
COORDINATOR_URL=http://coordinator:9443
COORDINATOR_API_KEY=b7c8d9e0f1...   # openssl rand -hex 32
CADDY_ADMIN_URL=http://caddy:2019
LOG_LEVEL=info
TLS_STRATEGY=on-demand
ATPROTO_PRIVATE_KEY='{"kty":"EC","crv":"P-256",...}'
OPERATOR_DIDS=did:plc:your-own-did
```

### Production `.env` example (legacy Headscale mode)

```sh
DATABASE_URL=postgresql://atproto_tailnet:strong-password@postgres:5432/atproto_tailnet
SESSION_SECRET=a1b2c3d4e5f6...   # openssl rand -hex 32
PORT=3000
PUBLIC_URL=https://tailnets.yourdomain.com
BASE_DOMAIN=ts.yourdomain.com
HEADSCALE_IMAGE=headscale/headscale:0.29.1
HEADSCALE_PORT_RANGE_START=10001
HEADSCALE_PORT_RANGE_END=10100
HEADSCALE_DATA_DIR=/data/headscale
CADDY_ADMIN_URL=http://caddy:2019
LOG_LEVEL=info
TLS_STRATEGY=on-demand
ATPROTO_PRIVATE_KEY='{"kty":"EC","crv":"P-256",...}'
OPERATOR_DIDS=did:plc:your-own-did
```

---

## First deployment on DigitalOcean

This procedure installs the coordinator-mode stack on one Droplet. It uses the
`digitalocean` TLS strategy (DNS-01 wildcard certificate). For the commands
that an agent can run without help, see
[`deploy/digitalocean/AGENT.md`](../deploy/digitalocean/AGENT.md).

In the examples, the dashboard is `tailnets.example.com` and the tenant domain
is `ts.example.com`. Replace them with your names.

### 1. Create the Droplet and the DNS records

1. Create an Ubuntu 22.04 (or later) Droplet with 2 GB RAM or more. Use an SSH
   key, not a password.
2. Add your domain to DigitalOcean DNS.
3. Add an A record for `APP_DOMAIN` that points to the Droplet.
4. Add an A record for the wildcard `*.BASE_DOMAIN` that points to the Droplet.

```sh
doctl compute domain records create example.com --record-type A --record-name tailnets --record-data <droplet-ip>
doctl compute domain records create example.com --record-type A --record-name '*.ts' --record-data <droplet-ip>
```

### 2. Create the DNS token

Caddy needs a DigitalOcean API token to make the DNS-01 challenge records.

1. In the DigitalOcean control panel, open **API → Tokens**.
2. Create a token with custom scopes, if your account supports them.
3. Give the token only the `domain` scopes (read, create, update, delete).
4. Keep the token. It goes into `DO_AUTH_TOKEN`.

If you cannot limit the scopes, use a read and write token. Do not use the
token of your workstation `doctl` on the server.

### 3. Run the setup script

Set `REPO_URL` to your repository, then run the script from your workstation:

```sh
ssh root@<droplet-ip> "REPO_URL=https://github.com/<you>/atproto-tailnet.git bash -s" < deploy/digitalocean/droplet-setup.sh
```

The script does these steps:

1. It installs Docker and the Compose plugin from the signed apt repository
   of Docker, and git. It checks the fingerprint of the Docker key first.
2. It clones the repository to `/opt/atproto-tailnet`.
3. It copies `.env.coordinator.example` to `.env`.
4. It generates `SESSION_SECRET`, `POSTGRES_PASSWORD`, `COORDINATOR_API_KEY`
   and `FEDERATION_KEY_ENCRYPTION_KEY`.
5. It sets the mode of `.env` to `600`.
6. It stops and tells you to edit `.env`.

### 4. Edit `.env`

Open the file on the Droplet:

```sh
ssh root@<droplet-ip>
cd /opt/atproto-tailnet
nano .env
```

Set these values:

```ini
PUBLIC_URL=https://tailnets.example.com
APP_DOMAIN=tailnets.example.com
BASE_DOMAIN=ts.example.com
TLS_STRATEGY=digitalocean
DO_AUTH_TOKEN=dop_v1_...
CADDY_DNS_PLUGINS=github.com/caddy-dns/digitalocean
OPERATOR_DIDS=did:plc:your-own-did
```

To find your DID, run this command:

```sh
curl "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=you.bsky.social"
```

Keep `FEDERATION_ENABLED` and `WEBHOOK_ALLOW_PRIVATE` unset.

### 5. Generate the OAuth key

Bluesky sign-in needs an ES256 private key in `ATPROTO_PRIVATE_KEY`. The app
image contains the `jose` library. Run this command in `/opt/atproto-tailnet`.
The first run builds the app image, so it takes some minutes.

```sh
docker compose -f docker-compose.coordinator.yml run --rm --no-deps --entrypoint node app \
  --input-type=module -e "import {generateKeyPair,exportJWK} from 'jose'; const {privateKey}=await generateKeyPair('ES256',{extractable:true}); console.log(JSON.stringify({...await exportJWK(privateKey),alg:'ES256'}))"
```

The command prints one line of JSON. Add it to `.env` between single quotes:

```ini
ATPROTO_PRIVATE_KEY='{"kty":"EC","x":"...","y":"...","crv":"P-256","d":"...","alg":"ES256"}'
```

Do not change this key after users sign in. Keep a copy with your other
secrets.

### 6. Start the stack

Run the setup script again, or start the stack directly:

```sh
docker compose -f docker-compose.coordinator.yml up -d
```

The first start builds Caddy with the DNS module, the app and the coordinator.
Caddy then gets the certificates.

### 7. Sign in first

Open `https://tailnets.example.com` and sign in with the Bluesky account in
`OPERATOR_DIDS`. Do this before you tell other people about the instance.

The service then creates your tailnet. This first operator tailnet becomes the
default tailnet of the instance, and it accepts join requests. In the
**Instance** tab you can change these items:

- The default tailnet
- Single-tailnet mode
- The tailnet creators

Other people who sign in get no tailnet. They see their invitations, or they
can request to join the default tailnet.

### 8. Verify

```sh
curl -f https://tailnets.example.com/health
curl -vI https://tailnets.example.com 2>&1 | grep -i issuer
docker compose -f docker-compose.coordinator.yml ps
```

When your tailnet runs, check the tenant subdomain too. A tenant subdomain
serves only `/key`, `/ts2021` and `/health` from the coordinator:

```sh
curl -f https://<your-slug>.ts.example.com/key
```

Then connect a device from the **Add Device** tab.

### 9. Connect Claude (optional)

In Claude, add a custom connector with the URL
`https://tailnets.example.com/mcp`. For the full procedure, see
[Connect Claude (MCP)](site/guides/mcp.md).

### 10. Harden the Droplet

Do the steps in [Droplet hardening](#droplet-hardening).

---

## Upgrades from older versions

The coordinator container runs as user `coord` (UID 100). Older versions ran it as root. If you upgrade a stack that has an old `coord_data` volume, the coordinator cannot read `control.key`. Run this command once, then restart the coordinator:

```sh
docker compose -f docker-compose.coordinator.yml run --rm --user root --entrypoint chown coordinator -R 100:101 /var/lib/coordinator
```

A new deployment does not need this step.

## Droplet hardening

These steps apply to each single-server deployment. The examples use
DigitalOcean.

### Cloud firewall

Docker writes its own iptables rules for published ports. Ports 80 and 443 of
Caddy bypass `ufw`, so `ufw` alone does not protect them. Use a DigitalOcean
Cloud Firewall. It filters traffic before it gets to the Droplet.

Open only these inbound ports:

| Protocol | Port | Source |
|----------|------|--------|
| TCP | 22 | Your IP address only |
| TCP | 80 | All |
| TCP | 443 | All |
| UDP | 443 | All |

```sh
doctl compute firewall create --name atproto-tailnet-fw \
  --droplet-ids <droplet-id> \
  --inbound-rules "protocol:tcp,ports:22,address:<your-ip>/32 protocol:tcp,ports:80,address:0.0.0.0/0,address:::/0 protocol:tcp,ports:443,address:0.0.0.0/0,address:::/0 protocol:udp,ports:443,address:0.0.0.0/0,address:::/0" \
  --outbound-rules "protocol:tcp,ports:all,address:0.0.0.0/0,address:::/0 protocol:udp,ports:all,address:0.0.0.0/0,address:::/0 protocol:icmp,address:0.0.0.0/0,address:::/0"
```

Do not publish 5432 (PostgreSQL), 3000 (app), 9443 (coordinator) or 2019
(Caddy admin). The compose file keeps them internal.

### SSH keys only

Turn off password login:

```sh
cat > /etc/ssh/sshd_config.d/99-hardening.conf <<'CONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
CONF
systemctl reload ssh
```

Keep your current SSH session open. Test a new login before you close it.

### Automatic security updates

```sh
apt-get install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades
```

### Protect `.env`

The file contains all secrets. Only root must read it:

```sh
chmod 600 /opt/atproto-tailnet/.env
```

The setup script does this when it creates the file. Do the step again if you
copy or replace the file.

### Limit the DigitalOcean token

The token in `DO_AUTH_TOKEN` stays on the server. If possible, use a token with
only the `domain` scopes. Then a stolen token cannot create or delete
Droplets.

### Operators before the first sign-in

Set `OPERATOR_DIDS` before you start the stack the first time. Sign in as the
operator first. Without operators, nobody can create a tailnet and nobody can
use the **Instance** tab.

### Backups

Back up these two Docker volumes:

| Volume | Contents | If you lose it |
|--------|----------|----------------|
| `pgdata` | All users, tailnets, memberships, keys and coordinator state | You lose the instance |
| `coord_data` | The Noise control key (`/var/lib/coordinator/control.key`) | Every device must register again |

```sh
mkdir -p /root/backups && cd /opt/atproto-tailnet
docker compose -f docker-compose.coordinator.yml exec -T postgres \
  pg_dump -U atproto_tailnet atproto_tailnet | gzip > /root/backups/db-$(date +%Y%m%d).sql.gz
docker compose -f docker-compose.coordinator.yml cp \
  coordinator:/var/lib/coordinator/control.key /root/backups/control.key
chmod 600 /root/backups/*
```

Copy the backups off the Droplet. `scripts/backup.sh` does not include the
control key. You can also turn on DigitalOcean Droplet backups.

### Docker log rotation

The default Docker log driver keeps all logs. Limit the log size:

```sh
cat > /etc/docker/daemon.json <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "5" } }
JSON
systemctl restart docker
cd /opt/atproto-tailnet && docker compose -f docker-compose.coordinator.yml up -d --force-recreate
```

The new settings apply only to containers that Docker creates after the
change.

### Built-in protections

The stack has these protections. You do not need to configure them:

- The app and the coordinator containers run as non-root users.
- PostgreSQL is only on the `internal` network. Caddy is only on the `edge`
  network.
- Caddy sends HSTS (`max-age=31536000`) on `APP_DOMAIN`.
- Caddy returns 404 for `/internal/*` on `APP_DOMAIN`.
- Tenant subdomains serve only `/key`, `/ts2021` and `/health`.

---

## TLS and wildcard DNS with Caddy

Caddy terminates TLS with Let's Encrypt certificates. The TLS strategy is
pluggable. Set `TLS_STRATEGY` in `.env` to choose how Caddy obtains
certificates. Each strategy is a directory in `caddy/tls-strategies/`. The
files in each directory document the requirements of the strategy.

### DNS records

| Type | Name | Value |
|------|------|-------|
| A | `tailnets.yourdomain.com` | `<server IP>` |
| A | `*.ts.yourdomain.com` | `<server IP>` |
| A (optional) | `*.svc.ts.yourdomain.com` | `<server IP>` |

HTTPS service names (ADR-0038) are `<name>.<SERVICE_DOMAIN>`. The default is
`svc.<BASE_DOMAIN>`. Caddy obtains a separate DNS-01 wildcard for
`*.<SERVICE_DOMAIN>`, and only that certificate goes to the gateway. Devices
resolve service names through the coordinator, so the A record is optional.
Without it, a service name does not resolve on the internet. To use another
domain, set `SERVICE_DOMAIN`. Its wildcard must not cover `APP_DOMAIN`,
`CONTROL_DOMAIN` or `DERP_DOMAIN`, and the DNS-01 credentials must reach its
zone. Use a DNS-01 strategy: with `on-demand` or `manual`, the gateway gets no
certificate.

### TLS strategies

| Strategy | How it works | DNS credentials needed |
|----------|-------------|----------------------|
| `on-demand` (default) | Per-tenant cert on first connection | None |
| `cloudflare` | DNS-01 wildcard | `CF_API_TOKEN` |
| `route53` | DNS-01 wildcard | AWS credentials |
| `digitalocean` | DNS-01 wildcard | `DO_AUTH_TOKEN` |
| `rfc2136` | DNS-01 wildcard | TSIG keys (BIND/Knot/PowerDNS) |
| `acmedns` | DNS-01 wildcard through delegation | acme-dns credentials + one CNAME |
| `hetzner` | DNS-01 wildcard | `HETZNER_API_TOKEN` |
| `vultr` | DNS-01 wildcard | `VULTR_API_KEY` |
| `manual` | Use your own wildcard cert | None |

DNS-01 strategies need a Caddy image that includes the DNS module. Set
`CADDY_DNS_PLUGINS` in `.env` to the Go module path (e.g.,
`github.com/caddy-dns/route53`). The `on-demand` and `manual` strategies
use stock Caddy and do not need a build step.

Pin the module to a version: write `module@version`, for example
`github.com/caddy-dns/route53@v1.6.0`. Use a tag of the module, or a Go
pseudo-version for a module without tags. `Dockerfile.caddy` has a pinned
version of `github.com/caddy-dns/digitalocean` and uses it when you give no
version. For another module without a version, the build uses the newest
version and prints a warning. Go checks each module against
`sum.golang.org`.

### Caddyfile

The production Caddyfiles (`Caddyfile.coordinator.production` and
`Caddyfile.production`) import the TLS strategy from a mounted directory
(`/etc/caddy/tls-strategy/`). The compose files mount the
correct strategy automatically, based on `TLS_STRATEGY`. Set `APP_DOMAIN` and
`BASE_DOMAIN` in `.env`. You do not need to edit the Caddyfile.

---

## Docker Compose — Coordinator mode (recommended)

The coordinator stack runs all services as containers. It does not need the
Docker socket:

```sh
git clone https://github.com/your-org/atproto-tailnet.git
cd atproto-tailnet

cp .env.coordinator.example .env
# Edit .env with production values (COORDINATOR_API_KEY, SESSION_SECRET, etc.)

docker compose -f docker-compose.coordinator.yml up -d
```

This command starts the TS service, the Rust coordinator, PostgreSQL, and
Caddy. For a first deployment, use the procedure in
[First deployment on DigitalOcean](#first-deployment-on-digitalocean). The
same steps apply on other hosts.

The coordinator manages all tenants. It stores its Noise control key on the
`coord_data` volume. Back up this volume.

The coordinator runs as two services (ADR-0038). `coordinator`
(`COORD_ROLE=control`) serves the Noise control plane and the admin API.
`relay` (`COORD_ROLE=relay`) serves DERP, STUN on `STUN_PORT` and the gateway
for HTTPS services. `relay` has no admin key and no control key. It keeps
`derp.key` and `gateway.key` on the `relay_data` volume. `DERP_DOMAIN` is
required. On the first start after an upgrade, the one-shot `relay-keys`
service moves the two keys from `coord_data` to `relay_data`.
`relay` uses its own database role, `tailnet_relay`, with few privileges. The
one-shot `relay-db-role` service creates the role at each start and keeps its
random password on `relay_data`. You do not set this password.
Each tenant sets its own DERP relays in the dashboard. The service stores the
settings and sends them to the coordinator for that tenant only. Connected
devices receive the new relay map immediately. You do not need to restart the
stack.

### Updating

```sh
git pull
docker compose -f docker-compose.coordinator.yml build
docker compose -f docker-compose.coordinator.yml up -d
```

---

## Docker Compose — Legacy Headscale mode

Use this mode for deployments that use one Headscale container for each
tenant:

```sh
git clone https://github.com/your-org/atproto-tailnet.git
cd atproto-tailnet

cp .env.example .env
# Edit .env with production values

docker compose -f docker-compose.production.yml up -d
```

This command starts the app, PostgreSQL, and Caddy. The app accesses the Docker
socket through a bind mount. The app can then create Headscale containers on
the host.

The Caddy admin API listens on `10.250.250.2:2019` on the private network
`caddy_admin`. Only Caddy and the app (`10.250.250.3`) are on this network.
The tenant Headscale containers and the other services cannot reach the admin
API. This is the same as in the coordinator stack. If you upgrade from an
older version, run `docker compose -f docker-compose.production.yml up -d`
for both services, so that they join the new network.

### Updating

```sh
git pull
docker compose -f docker-compose.production.yml build app
docker compose -f docker-compose.production.yml up -d app
```

### Viewing logs

```sh
docker compose -f docker-compose.production.yml logs -f app
```

---

## Platform-specific guides

These guides give detailed setup instructions for each platform:

- **DigitalOcean**: [`deploy/digitalocean/README.md`](../deploy/digitalocean/README.md) and [`deploy/digitalocean/AGENT.md`](../deploy/digitalocean/AGENT.md)
- **Hetzner**: [`deploy/hetzner/AGENT.md`](../deploy/hetzner/AGENT.md)
- **Vultr**: [`deploy/vultr/AGENT.md`](../deploy/vultr/AGENT.md)
- **AWS**: [`deploy/aws/README.md`](../deploy/aws/README.md)
- **Kubernetes**: [`deploy/kubernetes/README.md`](../deploy/kubernetes/README.md) (network policies, and a separate database role for the relays)
- **Railway**: [`deploy/railway/README.md`](../deploy/railway/README.md)

---

## Health check

The app has a `GET /health` endpoint. It returns `200 OK` when the service and
the database connection are healthy. Use it for load balancer health checks
and deployment readiness probes.

```sh
curl -f https://tailnets.yourdomain.com/health
```

---

## Backups

### PostgreSQL

Use the compose file of your mode. The example uses the Headscale mode file.
For coordinator mode, use `docker-compose.coordinator.yml`.

```sh
# Manual dump
docker compose -f docker-compose.production.yml \
  exec -T postgres pg_dump -U atproto_tailnet atproto_tailnet | gzip > backup.sql.gz

# Restore
gunzip -c backup.sql.gz | docker compose -f docker-compose.production.yml \
  exec -T postgres psql -U atproto_tailnet atproto_tailnet
```

### Coordinator control key

In coordinator mode, also back up the `coord_data` volume. It holds the Noise
control key. See [Backups](#backups) in Droplet hardening.

### Headscale data

The `HEADSCALE_DATA_DIR` directory contains the configuration files and SQLite
databases of each tenant. Back up the complete directory:

```sh
tar czf headscale-backup-$(date +%Y%m%d).tar.gz /data/headscale/
```

---

## Security considerations

- `SESSION_SECRET` must be a cryptographically random string of 32 characters
  or more.
- `ATPROTO_PRIVATE_KEY` is an ES256 JWK. Keep it in a secrets manager. Do not
  keep it in version control.
- `OPERATOR_DIDS` controls who gets a tailnet and who can use the operator
  API. Set it before the first sign-in.
- `TRUST_PROXY` must be `1` behind Caddy. Do not set it when the app is
  directly on the internet. A wrong value lets clients fake their IP address
  for the rate limits.
- `COORDINATOR_API_KEY` and `COORD_ADMIN_KEY` must be equal and strong. This
  key protects all admin operations on the coordinator.
- **Coordinator mode**: The coordinator listens on port 9443. The compose file
  does not publish this port. Do not let the public internet reach it. The
  coordinator admin API uses constant-time Bearer token authentication.
- Docker-published ports bypass `ufw`. Use the firewall of your cloud
  provider. See [Droplet hardening](#droplet-hardening).
- **Headscale mode**: The Docker socket mount gives the app root-equivalent
  access to the host. Harden the host and make sure the app is the only
  consumer. Use a firewall to let only Tailscale protocol traffic (DERP/STUN)
  reach the Headscale ports (10001-10100).
- The app has built-in rate limiting (10 req/min for auth, 60 req/min for the
  API).
- The coordinator limits the request body to 2 MiB on all routes.
- The dashboard HTML-escapes all user-controlled data.
- CSP: `script-src 'self'; style-src 'self'`

### Supply chain

- The Dockerfiles and the compose files give each base image as
  `image:tag@sha256:digest`. Docker uses the digest. The tag is there for the
  reader. To update an image, get the new digest with
  `docker buildx imagetools inspect <image:tag>` and replace it.
- The app image installs its runtime packages from `package-lock.json` with
  `npm ci --omit=dev --ignore-scripts`, as the `node` user. `drizzle-kit`
  (the migrations) is a runtime dependency, so it comes from the lockfile
  too. Build and test tools (`vitest`, `tsx`, `typescript`, React, the
  `@types` packages) are development dependencies and are not in the image.
- After you change dependencies, write the lockfile with npm 10, the version
  in the `node:22-alpine` image:
  `docker run --rm -v "$PWD":/app -w /app -u "$(id -u):$(id -g)" -e npm_config_cache=/tmp/npmcache node:22-alpine npm install --package-lock-only --ignore-scripts`.
- The setup scripts install Docker from its signed apt repository, not with
  `get.docker.com`.
- CI (`.github/workflows/ci.yml`) runs on each push and pull request: type
  checks, the dashboard build and the tests of the TS service, and clippy and
  the tests of the coordinator with a PostgreSQL service. The workflow actions
  are pinned to commits.
