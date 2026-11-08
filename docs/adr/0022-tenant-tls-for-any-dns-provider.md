# ADR-0022: Tenant TLS for any DNS provider

**Status:** Proposed
**Date:** 2026-11-05
**Priority:** P1
**Depends On:** ADR-0002 (instance per tenant), ADR-0004 (project architecture)

## Context

Every tenant's Headscale is served at `https://<slug>.<BASE_DOMAIN>` through
Caddy (ADR-0004). In production that needs a certificate for every tenant
name. `Caddyfile.production` gets one wildcard certificate for
`*.<BASE_DOMAIN>`, and it is hard-wired to one DNS host:

```
*.ts.example.com {
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}
}
```

with `Dockerfile.caddy` building Caddy with exactly that module, and
`CF_API_TOKEN` threaded through the compose file and the AWS / DigitalOcean
deploy scripts. An operator whose domain is hosted anywhere else cannot
deploy without editing three files and knowing why.

Why DNS is involved at all: a public CA will only issue a **wildcard**
certificate after a DNS challenge — the applicant must place a TXT record
under the domain — so Caddy needs credentials for the domain's DNS host.
The main app's certificate (`tailnets.example.com`, a single name) has no
such constraint: it is issued over port 80/443 and works with any DNS host
today. Only the tenant wildcard is tied to a provider.

### What was investigated

Sources are the Caddy and Let's Encrypt documentation, the `caddy-dns`
GitHub organization, the Headscale reverse-proxy documentation and the
Let's Encrypt community forum, all read on 2026-11-05, plus a local spike
(`scripts/spikes/tenant-tls/run.sh`, 22 checks).

| Option | Works with | DNS credential on the server | Tenant names made public | Status |
|--------|-----------|------------------------------|--------------------------|--------|
| A. Wildcard, provider module | Any host with a Caddy module — 100 in `caddy-dns` | Yes, for the real zone | No | What we do, Cloudflare only |
| B. Wildcard, challenge delegated by CNAME | **Any** host (needs one static CNAME) | Yes, but only for a separate challenge zone | No | Supported by Caddy (`dns_challenge_override_domain`) |
| C. Wildcard, acme-dns | **Any** host (one static CNAME) | A credential that can only answer challenges | No | Module exists; needs an acme-dns server |
| D. Wildcard, RFC 2136 | Self-hosted BIND / Knot / PowerDNS | TSIG key | No | Module exists |
| E. Per-tenant certificates on demand | **Any** host (wildcard A record only) | None | **Yes** | Supported by Caddy; needs an endpoint in the service |
| F. Operator-supplied wildcard certificate | Any | None | No | Supported by Caddy; renewal is manual |
| G. `dns-persist-01` (one permanent TXT record) | Any | None | No | **Not available** — see below |
| H. TLS at Cloudflare's proxy / Tunnel | — | — | — | **Does not work** with Headscale |

Findings behind the table:

- **Provider modules (A).** DNS modules are compiled into Caddy; the stock
  image has none, so each deployment needs a build with the right one.
  `caddy-dns` has modules for 100 providers, including Route 53,
  DigitalOcean, Google Cloud DNS, Azure, Hetzner, OVH, Gandi, Namecheap,
  Porkbun, GoDaddy and deSEC. Each has its own configuration syntax and
  credentials (a single token for some, a block of several fields for
  others), so a provider cannot be selected with one environment variable.
- **Delegation (B, C).** A CNAME at
  `_acme-challenge.<BASE_DOMAIN>` pointing into another zone lets the
  challenge be answered there. The base domain can stay at a host with no
  API; the credential on the server can only touch the challenge zone, not
  the operator's real DNS. acme-dns is a small server built for exactly
  this, whose credentials can do nothing but answer challenges.
- **On-demand certificates (E).** Caddy can obtain a certificate for a
  hostname at the first TLS handshake, using the port 80/443 challenges —
  no DNS access. Caddy's documentation requires this to be restricted by an
  "ask" endpoint that says whether a name may have a certificate. It has
  two costs specific to this project:
  - *Disclosure.* Every publicly trusted certificate is published in
    Certificate Transparency logs. A wildcard certificate reveals nothing
    about tenants; per-tenant certificates publish every tenant hostname —
    and slugs are derived from Bluesky handles
    (`alice-bsky-social.ts.example.com`). That conflicts with a rule the
    API keeps deliberately (non-members get 404 "so tenant existence is not
    leaked").
  - *Rate limits.* Let's Encrypt issues at most 50 new certificates per
    registered domain per 7 days (refilling one every 202 minutes), and
    `ts.example.com` counts against `example.com`. That caps new tenants at
    about 50 a week unless an override is granted. Renewals are exempt.
- **`dns-persist-01` (G)** would be the ideal answer — a single TXT record
  set once by hand, valid for wildcards, no credentials anywhere. Let's
  Encrypt announced it in February 2026 targeting production in Q2, but as
  of its staff's last statement on the deployment thread (25 June 2026) it
  will not ship until an open issue in the IETF draft is resolved; it is
  available on staging only. No evidence was found that Caddy supports it.
- **Cloudflare proxy (H).** Headscale's documentation states that running
  behind Cloudflare's proxy or Tunnel "is not supported and will not work",
  because the Tailscale control protocol's upgrade request is not passed.
  `deploy/aws/README.md` currently says the wildcard record "can use
  orange-cloud (proxied)", and `deploy/railway/README.md` suggests a
  Cloudflare proxy; both are wrong for tenant hostnames.

Spike results (Caddy's internal CA standing in for a public one; no CA or
DNS provider was contacted):

| Check | Result |
|-------|--------|
| One Caddy build with several DNS modules chosen by a build argument | Works |
| Production-shaped Caddyfile with the TLS strategy imported from a mounted directory: Cloudflare, Route 53, DigitalOcean, RFC 2136, acme-dns, CNAME delegation, operator-supplied certificate, on-demand | All eight load (`caddy validate`) |
| Stock Caddy image with a DNS strategy | Refuses to start (`module not registered`) |
| Wildcard strategy with the service's managed tenant route (ADR-0004, `orchestrator/caddy.ts`) | Tenant proxied; certificate names `*.<BASE_DOMAIN>`; unknown name gets 404 |
| On-demand strategy with the same managed route | Tenant proxied; certificate names the one tenant; unknown name is refused at the TLS handshake and nothing is issued |
| Main app site under either strategy | Unaffected |

So the routing built for tenant subdomains does not care which strategy
supplies the certificate. No change to the service is needed for any
wildcard strategy.

## Decision

### 1. The tenant TLS strategy is a deployment setting

`Caddyfile.production` stops naming a DNS provider. The tenant wildcard
site imports its TLS configuration from a strategy directory:

```
{
	…
	import /etc/caddy/tls/global.caddy
}

*.{$BASE_DOMAIN} {
	import /etc/caddy/tls/site.caddy
}
```

The repository ships one directory per strategy under `caddy/tls/`, each a
few lines with its credentials read from environment variables and a
comment saying what DNS records it needs. `TENANT_TLS` in `.env` selects
which directory the compose file mounts. An operator with an unusual
provider writes their own directory; nothing else changes.

Shipped strategies:

| `TENANT_TLS` | For |
|--------------|-----|
| `cloudflare` (default, as today), `route53`, `digitalocean`, … | DNS host with a Caddy module |
| `delegated` | Any DNS host: CNAME the challenge to a zone at a provider with a module |
| `acmedns` | Any DNS host: CNAME the challenge to an acme-dns server |
| `rfc2136` | Self-hosted authoritative DNS |
| `manual` | A wildcard certificate obtained elsewhere |
| `on-demand` | No DNS credentials at all — see §3 |

Starting with a small set of providers is fine; adding one is a
three-line directory plus a module name.

### 2. The Caddy build takes its modules as an argument

`Dockerfile.caddy` gains `ARG CADDY_PLUGINS`, defaulting to the Cloudflare
module so existing deployments build unchanged. The compose file passes
`CADDY_PLUGINS` from `.env`. The `manual` and `on-demand` strategies need
no module and can run the stock image.

### 3. On-demand certificates are opt-in, with the costs stated

`on-demand` is the only strategy that needs no DNS setup beyond a wildcard
A record, so it stays available — but not as the default, because it
publishes tenant hostnames and limits tenant creation (Context). Its
strategy file and the README say both plainly.

It needs one addition to the service: an endpoint Caddy asks before
obtaining a certificate, answering 2xx only when the hostname is
`<slug>.<BASE_DOMAIN>` for a tenant that is not deleted. That endpoint
answers "does this tenant exist", so it must only be reachable by Caddy:
it is served on the internal network and the Caddyfile refuses the path on
the public site.

### 4. Recommended choice, in order

1. DNS host has a module and can issue a token limited to one zone →
   that provider's strategy.
2. No module, or the only credential is account-wide → `delegated` or
   `acmedns`, so the server never holds a credential for the real zone.
3. Self-hosted DNS → `rfc2136`.
4. None of these possible → `manual`, or `on-demand` with its costs
   accepted.

### 5. Correct the deployment docs

Tenant hostnames must resolve straight to the server ("DNS only" at
Cloudflare); remove the proxied-record and Cloudflare-proxy suggestions
from the AWS and Railway guides. `CF_API_TOKEN` in the deploy scripts
becomes one example of strategy credentials rather than a fixed parameter.

### 6. Revisit when `dns-persist-01` ships

Once Let's Encrypt offers it in production and Caddy supports it, it
should become the default: one hand-made TXT record, no credential on the
server, no provider module, no custom build.

## Consequences

- Any DNS host can be used: directly if it has a module, and by a one-time
  CNAME if it does not.
- No service code changes for wildcard strategies; `on-demand` adds one
  internal endpoint.
- Operators must choose a strategy and, for module-based ones, build Caddy
  — one more deployment step than a stock image, as today.
- More shipped configuration to keep working: each strategy file depends
  on a third-party module's syntax, which can change. Only the strategies
  we can load in CI (`caddy validate`, as the spike does) should ship.
- The delegated strategies add a second zone or a small extra service
  (acme-dns needs public port 53 and an NS delegation) in exchange for
  keeping real DNS credentials off the server.

## To verify before or during implementation

The spike proved configuration and routing, not issuance:

- **Real issuance** for each shipped strategy — against Let's Encrypt
  staging with a real domain, or locally against Pebble (Let's Encrypt's
  test CA). In particular the CNAME-delegated and acme-dns flows, and
  renewal.
- **On-demand under load**: first-connection delay for a new tenant's
  first device, and behaviour when the weekly limit is reached (Caddy
  falls back to ZeroSSL by default — whether that is acceptable).
- **`{$BASE_DOMAIN}` in the site address** and how it interacts with the
  service's managed route when the two disagree.
- **Current state of `dns-persist-01`**: later third-party reports mention
  a revised draft in September 2026; no Let's Encrypt production
  announcement was found.

## Not in scope

- Tenants bringing their own domain names.
- TLS for the local development setup, which stays plain HTTP.
- Fixing the production compose file's other problems (the app container
  cannot reach tenant APIs on `localhost`; data-directory mounts).

## Sources

- Caddy — Automatic HTTPS: <https://caddyserver.com/docs/automatic-https>
- Caddy — `tls` directive: <https://caddyserver.com/docs/caddyfile/directives/tls>
- `caddy-dns` modules: <https://github.com/orgs/caddy-dns/repositories>
- Let's Encrypt — Rate limits (updated 2026-08-05): <https://letsencrypt.org/docs/rate-limits/>
- Let's Encrypt community — dns-persist-01 deployment status: <https://community.letsencrypt.org/t/dns-persist-01-deployment-status-and-timeline/246468>
- Headscale — Reverse proxy: <https://headscale.net/stable/ref/integration/reverse-proxy/>
