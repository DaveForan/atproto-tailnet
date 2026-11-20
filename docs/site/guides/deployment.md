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

For a first deployment by hand, follow [First deployment on DigitalOcean](https://github.com/DaveForan/atproto-tailnet/blob/master/docs/deployment.md#first-deployment-on-digitalocean). The steps also apply to other providers. Then do the steps in [Droplet hardening](https://github.com/DaveForan/atproto-tailnet/blob/master/docs/deployment.md#droplet-hardening).

## Before you start

Prepare these values for `.env`:

- `OPERATOR_DIDS`: your own DID. Only operators and the tailnet creators that they designate get a tailnet. Set it before the first sign-in.
- `ATPROTO_PRIVATE_KEY`: an ES256 JWK. Production sign-in needs it. See [Authentication](../reference/configuration#authentication).
- `PUBLIC_URL`, `APP_DOMAIN` and `BASE_DOMAIN`.
- The DNS token for your TLS strategy.

The setup scripts generate the other secrets, or the `AGENT.md` files show how to generate them.

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

Only Caddy publishes ports (80 and 443). PostgreSQL is on an internal network that Caddy cannot reach. On tenant subdomains, Caddy sends only `/key`, `/ts2021` and `/health` to the coordinator.

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
| A | `control.yourdomain.com` (your `CONTROL_DOMAIN`) | Server IP |
| A | `derp.yourdomain.com` (your `DERP_DOMAIN`) | Server IP |

Set `CONTROL_DOMAIN` and `DERP_DOMAIN` in `.env` to these hostnames. Open UDP port 3478 (STUN) in your firewall, together with TCP 80 and 443. Without `DERP_DOMAIN`, devices that cannot connect directly cannot reach each other.

The AGENT.md file of each provider contains the exact CLI commands to create these records.

## After deployment

When the stack runs, do these steps:

1. **Sign in first**: Go to `https://tailnets.yourdomain.com` and sign in with the account in `OPERATOR_DIDS`. Your tailnet becomes the default tailnet of the instance and accepts join requests.
2. **Verify health**: `curl https://tailnets.yourdomain.com/health`
3. **Check TLS**: `curl -vI https://tailnets.yourdomain.com 2>&1 | grep issuer`
4. **View logs**: `docker compose -f docker-compose.coordinator.yml logs -f`
5. **Connect Claude (optional)**: Add a custom connector with the URL `https://tailnets.yourdomain.com/mcp`. See [Connect Claude (MCP)](mcp).

Other people who sign in get no tailnet. They see their invitations, or they can request to join the default tailnet. Use the **Invite** tab to invite people, and the **Instance** tab to manage the instance.

## Updating

```sh
cd /opt/atproto-tailnet
git pull
docker compose -f docker-compose.coordinator.yml build
docker compose -f docker-compose.coordinator.yml up -d
```

## Security checklist

- `OPERATOR_DIDS` contains your DID, and you signed in first
- `SESSION_SECRET` is a unique random string (32+ characters). The app refuses weak values
- `COORDINATOR_API_KEY` is a strong random value (32+ characters)
- `FEDERATION_KEY_ENCRYPTION_KEY` is 64 random hex characters
- `ATPROTO_PRIVATE_KEY` is set for production AT Proto OAuth
- `FEDERATION_ENABLED` is not set (federation is off by default)
- `.env` has mode `600`
- The PostgreSQL password is strong, and the internet cannot reach PostgreSQL
- The cloud firewall of the provider opens only ports 22 (your IP only), 80, 443, and 443/udp. Docker-published ports bypass `ufw`
- Port 9443 (coordinator) is **not** exposed. It is internal to Docker
- You back up the `pgdata` and `coord_data` volumes
