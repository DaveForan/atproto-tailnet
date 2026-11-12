---
title: Deployment
---

# Deployment

atproto-tailnet can be deployed on any server with Docker. Four cloud providers have fully automated deployment orchestration that an AI agent (or human) can run end-to-end: server provisioning, DNS setup, TLS certificates, and stack startup.

## Provider comparison

| Provider | CLI tool | Cost/month | TLS strategy | Notes |
|----------|----------|-----------|--------------|-------|
| [Hetzner](#hetzner) | `hcloud` | ~EUR 4-8 | `hetzner` | Cheapest. DNS API is separate from Cloud API |
| [Vultr](#vultr) | `vultr-cli` | ~$6-24 | `vultr` | Simple API, good value |
| [DigitalOcean](#digitalocean) | `doctl` | ~$18-24 | `digitalocean` | Single API for compute + DNS |
| [AWS](#aws) | `aws` | ~$30-50 | `route53` | Most complex. Instance roles for TLS |

All providers deploy in **coordinator mode** using `docker-compose.coordinator.yml`. Each has an `AGENT.md` in its `deploy/<provider>/` directory with exact CLI commands for autonomous deployment.

## What gets deployed

```
                   Internet
                      |
              +-------+-------+
              |     Caddy     |  TLS (pluggable strategy)
              |  (80, 443)    |  Wildcard subdomains
              +---+-------+---+
                  |       |
        +---------+       +----------+
        v                            v
+---------------+          +-----------------+
|  TypeScript   |          |  Rust           |
|  Service      | <------> |  Coordinator    |
|  (port 3000)  |  REST    |  (port 9443)    |
+-------+-------+          +--------+--------+
        |                           |
        +----------+----------------+
                   v
            +--------------+
            |  PostgreSQL  |
            +--------------+
```

All four services run as Docker containers via a single `docker compose up -d`. The coordinator handles the Tailscale control protocol natively; no Docker socket mount is needed.

## TLS strategies

The `TLS_STRATEGY` environment variable selects how Caddy obtains certificates for tenant subdomains. Each strategy is a directory in `caddy/tls-strategies/` containing Caddy configuration snippets.

| Strategy | How it works | Needs DNS API? | Caddy module needed |
|----------|-------------|:---:|---|
| `on-demand` | Per-tenant cert on first connection | No | None |
| `cloudflare` | DNS-01 wildcard | Yes | `caddy-dns/cloudflare` |
| `route53` | DNS-01 wildcard | Yes | `caddy-dns/route53` |
| `digitalocean` | DNS-01 wildcard | Yes | `caddy-dns/digitalocean` |
| `hetzner` | DNS-01 wildcard | Yes | `caddy-dns/hetzner` |
| `vultr` | DNS-01 wildcard | Yes | `caddy-dns/vultr` |
| `rfc2136` | DNS-01 wildcard (BIND/Knot/PowerDNS) | Yes | `caddy-dns/rfc2136` |
| `acmedns` | DNS-01 wildcard via delegation | One-time CNAME | `caddy-dns/acmedns` |
| `manual` | Bring your own cert | No | None |

**On-demand** (default) is the simplest — no DNS provider API access required. DNS-01 strategies issue a single wildcard certificate, which is more efficient with many tenants. When your DNS provider matches your server provider, use that provider's strategy for fully autonomous deployment.

DNS-01 strategies require building Caddy with the appropriate module. Set `CADDY_DNS_PLUGINS` in `.env`:

```sh
CADDY_DNS_PLUGINS=github.com/caddy-dns/route53
```

## Hetzner

The cheapest option at ~EUR 4/month for a cx22 (2 vCPU, 4 GB RAM).

**Key detail**: Hetzner has two separate APIs with separate tokens. The Cloud API (`hcloud` CLI) manages servers. The DNS API (`dns.hetzner.com/api/v1`, curl only) manages DNS records. Both are needed.

```sh
# Full instructions
cat deploy/hetzner/AGENT.md

# Quick start
hcloud server create --name atproto-tailnet --type cx22 --image ubuntu-22.04 --ssh-key <name> --location fsn1
ssh root@$(hcloud server ip atproto-tailnet) 'bash -s' < deploy/hetzner/server-setup.sh
```

See [`deploy/hetzner/AGENT.md`](https://github.com/DaveForan/atproto-tailnet/blob/master/deploy/hetzner/AGENT.md) for the full step-by-step.

## Vultr

Good value starting at $6/month for a vc2-1c-2gb (1 vCPU, 2 GB RAM).

```sh
# Full instructions
cat deploy/vultr/AGENT.md

# Quick start
vultr-cli instance create --plan vc2-1c-2gb --region ewr --os 2284 --ssh-keys <id> --label atproto-tailnet
ssh root@<ip> 'bash -s' < deploy/vultr/server-setup.sh
```

See [`deploy/vultr/AGENT.md`](https://github.com/DaveForan/atproto-tailnet/blob/master/deploy/vultr/AGENT.md) for the full step-by-step.

## DigitalOcean

Single API covers compute and DNS. $18/month for an s-2vcpu-2gb Droplet.

```sh
# Full instructions
cat deploy/digitalocean/AGENT.md

# Quick start
doctl compute droplet create atproto-tailnet --region nyc1 --size s-2vcpu-2gb --image ubuntu-22-04-x64 --ssh-keys <fingerprint> --wait
ssh root@$(doctl compute droplet get atproto-tailnet --format PublicIPv4 --no-header) 'bash -s' < deploy/digitalocean/droplet-setup.sh
```

See [`deploy/digitalocean/AGENT.md`](https://github.com/DaveForan/atproto-tailnet/blob/master/deploy/digitalocean/AGENT.md) for the full step-by-step.

## AWS

EC2 + Route53. Most complex setup but supports instance roles for TLS (no API keys needed on the instance). ~$30/month for a t3.medium.

Two deployment paths:
- **Path A (minimal)**: Manual EC2 + Route53 via AWS CLI
- **Path B (CloudFormation)**: Automated via the included `cloudformation.yaml` template

```sh
# Full instructions
cat deploy/aws/AGENT.md
```

See [`deploy/aws/AGENT.md`](https://github.com/DaveForan/atproto-tailnet/blob/master/deploy/aws/AGENT.md) for both paths.

## DNS requirements

Regardless of provider, you need two DNS records pointing to your server:

| Type | Name | Value |
|------|------|-------|
| A | `tailnets.yourdomain.com` (or your `APP_DOMAIN`) | Server IP |
| A | `*.ts.yourdomain.com` (or `*.<BASE_DOMAIN>`) | Server IP |

The AGENT.md files for each provider include the exact CLI commands to create these records.

## After deployment

Once the stack is running:

1. **Verify health**: `curl https://tailnets.yourdomain.com/health`
2. **Check TLS**: `curl -vI https://tailnets.yourdomain.com 2>&1 | grep issuer`
3. **View logs**: `docker compose -f docker-compose.coordinator.yml logs -f`
4. **Sign in**: Visit `https://tailnets.yourdomain.com` and authenticate with your AT Protocol handle

## Updating

```sh
cd /opt/atproto-tailnet
git pull
docker compose -f docker-compose.coordinator.yml build
docker compose -f docker-compose.coordinator.yml up -d
```

## Security checklist

- `SESSION_SECRET` is a unique random string (32+ characters)
- `COORDINATOR_API_KEY` is a strong random value
- `FEDERATION_KEY_ENCRYPTION_KEY` is 64 random hex characters (if using federation)
- `ATPROTO_PRIVATE_KEY` is set for production AT Proto OAuth
- PostgreSQL password is strong and not exposed to the internet
- Only ports 22, 80, 443, and 443/udp are open in the firewall
- Port 9443 (coordinator) is **not** exposed — it's internal to Docker
