---
title: Deployment
---

# Deployment

You can deploy atproto-tailnet on any server with Docker. Four cloud providers have fully automated deployment orchestration. An AI agent or a human can run it from start to finish: server provisioning, DNS setup, TLS certificates, and stack startup.

## Provider comparison

| Provider | CLI tool | Cost/month | TLS strategy | Notes |
|----------|----------|-----------|--------------|-------|
| [Hetzner](#hetzner) | `hcloud` | ~EUR 4-8 | `hetzner` | Cheapest. The DNS API is separate from the Cloud API |
| [Vultr](#vultr) | `vultr-cli` | ~$6-24 | `vultr` | Simple API, good value |
| [DigitalOcean](#digitalocean) | `doctl` | ~$18-24 | `digitalocean` | One API for compute and DNS |
| [AWS](#aws) | `aws` | ~$30-50 | `route53` | Most complex. Instance roles for TLS |

All providers deploy in **coordinator mode** and use `docker-compose.coordinator.yml`. Each provider has an `AGENT.md` in its `deploy/<provider>/` directory. The file contains the exact CLI commands for autonomous deployment.

## What the stack contains

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

All four services run as Docker containers when you use a single `docker compose up -d` command. The coordinator handles the Tailscale control protocol natively. You do not need a Docker socket mount.

## TLS strategies

The `TLS_STRATEGY` environment variable selects how Caddy obtains certificates for tenant subdomains. Each strategy is a directory in `caddy/tls-strategies/` that contains Caddy configuration snippets.

| Strategy | How it works | Needs DNS API? | Caddy module needed |
|----------|-------------|:---:|---|
| `on-demand` | Per-tenant cert on first connection | No | None |
| `cloudflare` | DNS-01 wildcard | Yes | `caddy-dns/cloudflare` |
| `route53` | DNS-01 wildcard | Yes | `caddy-dns/route53` |
| `digitalocean` | DNS-01 wildcard | Yes | `caddy-dns/digitalocean` |
| `hetzner` | DNS-01 wildcard | Yes | `caddy-dns/hetzner` |
| `vultr` | DNS-01 wildcard | Yes | `caddy-dns/vultr` |
| `rfc2136` | DNS-01 wildcard (BIND/Knot/PowerDNS) | Yes | `caddy-dns/rfc2136` |
| `acmedns` | DNS-01 wildcard through delegation | One-time CNAME | `caddy-dns/acmedns` |
| `manual` | Use your own cert | No | None |

**On-demand** (default) is the simplest strategy. It does not need access to a DNS provider API. DNS-01 strategies issue one wildcard certificate. This is more efficient when you have many tenants. When your DNS provider is the same as your server provider, use the strategy of that provider. Then the deployment is fully autonomous.

DNS-01 strategies need a Caddy build that includes the correct module. Set `CADDY_DNS_PLUGINS` in `.env`:

```sh
CADDY_DNS_PLUGINS=github.com/caddy-dns/route53
```

## Hetzner

Hetzner is the cheapest option. A cx22 server (2 vCPU, 4 GB RAM) costs ~EUR 4/month.

**Key detail**: Hetzner has two separate APIs, and each API has its own token. The Cloud API (`hcloud` CLI) manages servers. The DNS API (`dns.hetzner.com/api/v1`, curl only) manages DNS records. You need both tokens.

```sh
# Full instructions
cat deploy/hetzner/AGENT.md

# Quick start
hcloud server create --name atproto-tailnet --type cx22 --image ubuntu-22.04 --ssh-key <name> --location fsn1
ssh root@$(hcloud server ip atproto-tailnet) 'bash -s' < deploy/hetzner/server-setup.sh
```

For the full step-by-step procedure, see [`deploy/hetzner/AGENT.md`](https://github.com/DaveForan/atproto-tailnet/blob/master/deploy/hetzner/AGENT.md).

## Vultr

Vultr is good value. A vc2-1c-2gb server (1 vCPU, 2 GB RAM) costs $6/month and up.

```sh
# Full instructions
cat deploy/vultr/AGENT.md

# Quick start
vultr-cli instance create --plan vc2-1c-2gb --region ewr --os 2284 --ssh-keys <id> --label atproto-tailnet
ssh root@<ip> 'bash -s' < deploy/vultr/server-setup.sh
```

For the full step-by-step procedure, see [`deploy/vultr/AGENT.md`](https://github.com/DaveForan/atproto-tailnet/blob/master/deploy/vultr/AGENT.md).

## DigitalOcean

One API covers compute and DNS. An s-2vcpu-2gb Droplet costs $18/month.

```sh
# Full instructions
cat deploy/digitalocean/AGENT.md

# Quick start
doctl compute droplet create atproto-tailnet --region nyc1 --size s-2vcpu-2gb --image ubuntu-22-04-x64 --ssh-keys <fingerprint> --wait
ssh root@$(doctl compute droplet get atproto-tailnet --format PublicIPv4 --no-header) 'bash -s' < deploy/digitalocean/droplet-setup.sh
```

For the full step-by-step procedure, see [`deploy/digitalocean/AGENT.md`](https://github.com/DaveForan/atproto-tailnet/blob/master/deploy/digitalocean/AGENT.md).

## AWS

AWS uses EC2 and Route53. The setup is the most complex, but it supports instance roles for TLS. You do not need API keys on the instance. A t3.medium costs ~$30/month.

There are two deployment paths:
- **Path A (minimal)**: Set up EC2 and Route53 manually with the AWS CLI
- **Path B (CloudFormation)**: Use the included `cloudformation.yaml` template for automatic setup

```sh
# Full instructions
cat deploy/aws/AGENT.md
```

For both paths, see [`deploy/aws/AGENT.md`](https://github.com/DaveForan/atproto-tailnet/blob/master/deploy/aws/AGENT.md).

## DNS requirements

For all providers, you need two DNS records that point to your server:

| Type | Name | Value |
|------|------|-------|
| A | `tailnets.yourdomain.com` (or your `APP_DOMAIN`) | Server IP |
| A | `*.ts.yourdomain.com` (or `*.<BASE_DOMAIN>`) | Server IP |

The AGENT.md file of each provider contains the exact CLI commands to create these records.

## After deployment

When the stack runs, do these steps:

1. **Verify health**: `curl https://tailnets.yourdomain.com/health`
2. **Check TLS**: `curl -vI https://tailnets.yourdomain.com 2>&1 | grep issuer`
3. **View logs**: `docker compose -f docker-compose.coordinator.yml logs -f`
4. **Sign in**: Go to `https://tailnets.yourdomain.com` and authenticate with your AT Protocol handle

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
- `FEDERATION_KEY_ENCRYPTION_KEY` is 64 random hex characters (if you use federation)
- `ATPROTO_PRIVATE_KEY` is set for production AT Proto OAuth
- The PostgreSQL password is strong, and the internet cannot reach PostgreSQL
- The firewall opens only ports 22, 80, 443, and 443/udp
- Port 9443 (coordinator) is **not** exposed. It is internal to Docker
