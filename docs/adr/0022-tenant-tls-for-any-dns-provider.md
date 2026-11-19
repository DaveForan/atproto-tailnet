# ADR-0022: Tenant TLS for any DNS provider

**Status:** Proposed
**Date:** 2026-11-05
**Priority:** P1
**Depends On:** ADR-0002 (instance per tenant), ADR-0004 (project architecture)

## Context

Caddy serves the Headscale of every tenant at `https://<slug>.<BASE_DOMAIN>`
(ADR-0004). In production, each tenant name needs a certificate.
`Caddyfile.production` gets one wildcard certificate for `*.<BASE_DOMAIN>`. It
is hard-wired to one DNS host:

```
*.ts.example.com {
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}
}
```

`Dockerfile.caddy` builds Caddy with exactly that module. The compose file and
the AWS / DigitalOcean deploy scripts pass `CF_API_TOKEN` through. An operator
whose domain is hosted anywhere else cannot deploy without editing three files
and knowing why.

DNS is involved because a public CA issues a **wildcard** certificate only
after a DNS challenge. The applicant must place a TXT record under the domain.
Caddy therefore needs credentials for the DNS host of the domain. The
certificate of the main app (`tailnets.example.com`, a single name) has no such
constraint. The CA issues it over port 80/443, and it works with any DNS host
today. Only the tenant wildcard depends on a provider.

### What we investigated

The sources are the Caddy and Let's Encrypt documentation, the `caddy-dns`
GitHub organization, the Headscale reverse-proxy documentation, and the Let's
Encrypt community forum. We read all of them on 2026-11-05. We also ran a local
spike (`scripts/spikes/tenant-tls/run.sh`, 22 checks).

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

The findings behind the table:

- **Provider modules (A).** Caddy compiles DNS modules in. The stock image has
  none, so each deployment needs a build with the correct module. `caddy-dns`
  has modules for 100 providers. These include Route 53, DigitalOcean, Google
  Cloud DNS, Azure, Hetzner, OVH, Gandi, Namecheap, Porkbun, GoDaddy, and
  deSEC. Each module has its own configuration syntax and credentials. Some
  need a single token. Others need a block of fields. One environment variable
  therefore cannot select a provider.
- **Delegation (B, C).** A CNAME at `_acme-challenge.<BASE_DOMAIN>` points into
  another zone. The CA challenge is then answered in that zone. The base domain
  can stay at a host with no API. The credential on the server can touch only
  the challenge zone, and it cannot touch the real DNS of the operator. acme-dns
  is a small server that we can use for exactly this. Its credentials can do
  nothing but answer challenges.
- **On-demand certificates (E).** Caddy can obtain a certificate for a hostname
  at the first TLS handshake. It uses the port 80/443 challenges and needs no
  DNS access. The Caddy documentation requires an "ask" endpoint that restricts
  this. The endpoint says whether a name can have a certificate. This option
  has two costs that are specific to this project:
  - *Disclosure.* Every publicly trusted certificate appears in Certificate
    Transparency logs. A wildcard certificate reveals nothing about tenants.
    Per-tenant certificates publish every tenant hostname. Slugs come from
    Bluesky handles (`alice-bsky-social.ts.example.com`). That conflicts with a
    rule that the API keeps deliberately (non-members get 404 "so tenant
    existence is not leaked").
  - *Rate limits.* Let's Encrypt issues at most 50 new certificates for each
    registered domain every 7 days (it refills one every 202 minutes).
    `ts.example.com` counts against `example.com`. This limits new tenants to
    approximately 50 each week unless Let's Encrypt grants an override. Renewals
    are exempt.
- **`dns-persist-01` (G)** would be the ideal answer. It needs a single TXT
  record that an operator sets once by hand. It is valid for wildcards and
  needs no credentials anywhere. Let's Encrypt announced it in February 2026 and
  targeted production in Q2. The last statement of the staff on the deployment
  thread (25 June 2026) says that it will not ship until the IETF draft
  resolves an open issue. It is available on staging only. We found no
  evidence that Caddy supports it.
- **Cloudflare proxy (H).** The Headscale documentation states that running
  behind the Cloudflare proxy or Tunnel "is not supported and will not work".
  The proxy does not pass the upgrade request of the Tailscale control
  protocol. `deploy/aws/README.md` currently says that the wildcard record "can
  use orange-cloud (proxied)", and `deploy/railway/README.md` suggests a
  Cloudflare proxy. Both are wrong for tenant hostnames.

The spike results (the internal CA of Caddy replaced a public CA, and the spike
contacted no CA or DNS provider):

| Check | Result |
|-------|--------|
| One Caddy build with several DNS modules chosen by a build argument | Works |
| Production-shaped Caddyfile with the TLS strategy imported from a mounted directory: Cloudflare, Route 53, DigitalOcean, RFC 2136, acme-dns, CNAME delegation, operator-supplied certificate, on-demand | All eight load (`caddy validate`) |
| Stock Caddy image with a DNS strategy | Refuses to start (`module not registered`) |
| Wildcard strategy with the service's managed tenant route (ADR-0004, `orchestrator/caddy.ts`) | Tenant proxied; certificate names `*.<BASE_DOMAIN>`; unknown name gets 404 |
| On-demand strategy with the same managed route | Tenant proxied; certificate names the one tenant; unknown name is refused at the TLS handshake and nothing is issued |
| Main app site under either strategy | Unaffected |

The routing that we built for tenant subdomains does not depend on the strategy
that supplies the certificate. No wildcard strategy needs a change to the
service.

## Decision

### 1. The tenant TLS strategy is a deployment setting

`Caddyfile.production` no longer names a DNS provider. The tenant wildcard site
imports its TLS configuration from a strategy directory:

```
{
	…
	import /etc/caddy/tls/global.caddy
}

*.{$BASE_DOMAIN} {
	import /etc/caddy/tls/site.caddy
}
```

The repository ships one directory for each strategy under `caddy/tls/`. Each
directory has a few lines. It reads its credentials from environment variables.
A comment says which DNS records the strategy needs. `TENANT_TLS` in `.env`
selects the directory that the compose file mounts. An operator with an unusual
provider writes a directory of their own. Nothing else changes.

The shipped strategies:

| `TENANT_TLS` | For |
|--------------|-----|
| `cloudflare` (default, as today), `route53`, `digitalocean`, … | DNS host with a Caddy module |
| `delegated` | Any DNS host: CNAME the challenge to a zone at a provider with a module |
| `acmedns` | Any DNS host: CNAME the challenge to an acme-dns server |
| `rfc2136` | Self-hosted authoritative DNS |
| `manual` | A wildcard certificate obtained elsewhere |
| `on-demand` | No DNS credentials at all — see §3 |

We can start with a small set of providers. To add a provider, an operator adds
a three-line directory and a module name.

### 2. The Caddy build takes its modules as an argument

`Dockerfile.caddy` gains `ARG CADDY_PLUGINS`. The default is the Cloudflare
module, so existing deployments build without changes. The compose file passes
`CADDY_PLUGINS` from `.env`. The `manual` and `on-demand` strategies need no
module and can run the stock image.

### 3. On-demand certificates are opt-in, with the costs stated

`on-demand` is the only strategy that needs no DNS setup except a wildcard A
record. It stays available. It is not the default, because it publishes tenant
hostnames and limits tenant creation (see Context). Its strategy file and the
README state both costs plainly.

It needs one addition to the service. Caddy asks an endpoint before it obtains
a certificate. The endpoint answers 2xx only when the hostname is
`<slug>.<BASE_DOMAIN>` for a tenant that is not deleted. That endpoint answers
"does this tenant exist". Only Caddy can reach it. The service serves it on the
internal network, and the Caddyfile refuses the path on the public site.

### 4. Recommended choice, in order

1. The DNS host has a module and can issue a token that is limited to one zone.
   Use the strategy of that provider.
2. The DNS host has no module, or the only credential is account-wide. Use
   `delegated` or `acmedns`. The server then never holds a credential for the
   real zone.
3. The DNS is self-hosted. Use `rfc2136`.
4. None of these options is possible. Use `manual`, or use `on-demand` and
   accept its costs.

### 5. Correct the deployment docs

Tenant hostnames must resolve straight to the server ("DNS only" at
Cloudflare). Remove the proxied-record and Cloudflare-proxy suggestions from
the AWS and Railway guides. `CF_API_TOKEN` in the deploy scripts becomes one
example of strategy credentials instead of a fixed parameter.

### 6. Revisit when `dns-persist-01` ships

When Let's Encrypt offers `dns-persist-01` in production and Caddy supports it,
it should become the default. It needs one hand-made TXT record, no credential
on the server, no provider module, and no custom build.

## Consequences

- Operators can use any DNS host. They use it directly if it has a module. They
  use a one-time CNAME if it has none.
- No wildcard strategy needs a change to the service code. `on-demand` adds one
  internal endpoint.
- Operators must choose a strategy. For module-based strategies, they must also
  build Caddy. This is one more deployment step than a stock image, as today.
- We must keep more shipped configuration working. Each strategy file depends
  on the syntax of a third-party module, and that syntax can change. We should
  ship only the strategies that we can load in CI (`caddy validate`, as the
  spike does).
- The delegated strategies add a second zone or a small extra service (acme-dns
  needs public port 53 and an NS delegation). In exchange, the real DNS
  credentials stay off the server.

## To verify before or during implementation

The spike proved configuration and routing. It did not prove issuance:

- **Real issuance** for each shipped strategy. Use Let's Encrypt staging with a
  real domain, or use Pebble (the Let's Encrypt test CA) locally. Verify in
  particular the CNAME-delegated flow, the acme-dns flow, and renewal.
- **On-demand under load**: the first-connection delay for the first device of
  a new tenant. Also verify the behaviour when the weekly limit is reached
  (Caddy falls back to ZeroSSL by default). We must decide whether that is
  acceptable.
- **`{$BASE_DOMAIN}` in the site address** and how it interacts with the
  managed route of the service when the two disagree.
- **Current state of `dns-persist-01`**: later third-party reports mention a
  revised draft in September 2026. We found no Let's Encrypt production
  announcement.

## Not in scope

- Tenants that bring their own domain names.
- TLS for the local development setup, which stays plain HTTP.
- Fixing the other problems of the production compose file (the app container
  cannot reach tenant APIs on `localhost`; data-directory mounts).

## Sources

- Caddy — Automatic HTTPS: <https://caddyserver.com/docs/automatic-https>
- Caddy — `tls` directive: <https://caddyserver.com/docs/caddyfile/directives/tls>
- `caddy-dns` modules: <https://github.com/orgs/caddy-dns/repositories>
- Let's Encrypt — Rate limits (updated 2026-08-05): <https://letsencrypt.org/docs/rate-limits/>
- Let's Encrypt community — dns-persist-01 deployment status: <https://community.letsencrypt.org/t/dns-persist-01-deployment-status-and-timeline/246468>
- Headscale — Reverse proxy: <https://headscale.net/stable/ref/integration/reverse-proxy/>
