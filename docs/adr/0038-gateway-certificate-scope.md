# ADR-0038: Scope of the gateway certificate

**Status:** Accepted
**Date:** 2026-11-20
**Priority:** P1
**Depends On:** ADR-0029 (gateway node), ADR-0030 (named services), ADR-0034 (roles)
**Related:** ADR-0026 (tailnet addresses), ADR-0027 (DERP relay)

## Context

The gateway ends TLS for named HTTPS services. Before this ADR:

- Service names were `<name>.<BASE_DOMAIN>`. Tailnet addresses use the same
  namespace (`<address>.<BASE_DOMAIN>`), and enrolled devices still use these
  addresses as control URLs (aliases, ADR-0026).
- The gateway loaded Caddy's wildcard certificate `*.<BASE_DOMAIN>`. This
  certificate covers every tailnet address.
- The gateway ran in the coordinator process with `COORD_ROLE=all`. That
  process holds the Noise control key and the admin API key. It also faces the
  internet (Noise, DERP, STUN).

A memory or file leak in that process gave a key that impersonates the control
hostnames of all tailnets. Two names in one label namespace cannot get separate
wildcard certificates. Per-name certificates put every service name in
Certificate Transparency logs (ADR-0030 refuses that).

## Decision

1. **Service domain.** HTTPS service names are `<name>.<SERVICE_DOMAIN>`.
   The default is `svc.<BASE_DOMAIN>`. The label `svc` is a reserved tailnet
   address. Caddy obtains a separate DNS-01 wildcard `*.<SERVICE_DOMAIN>`.
   The `gateway-certs` helper copies only this certificate.
2. **The gateway refuses a wider certificate.** At load and at each reload,
   every SAN of the leaf must be `*.<SERVICE_DOMAIN>` or one label under it.
   Otherwise the gateway does not start, or it keeps the old certificate.
   `COORD_GATEWAY_CERT` without `COORD_SERVICE_DOMAIN` is a start-up error.
3. **Process separation.** The compose stack runs two coordinator processes:
   - `coordinator` (`COORD_ROLE=control`): Noise, admin API, control key. It
     never mounts the certificate.
   - `relay` (`COORD_ROLE=relay`): DERP, STUN and the gateway. It has no admin
     key and no control key file. The gateway stays next to its relay
     (ADR-0029). The relay process loads tenant configuration and follows
     replica events (ADR-0034), so it learns new services and sign-in names.
   A control process with `COORD_SERVICE_DOMAIN` reports `gateway: true` and
   `service_domain` in `/health`. The TS service builds service URLs from
   `service_domain`.
4. **Files.** The key is `0600` and belongs to the gateway user. The
   certificate is `0644`. The helper writes each file with `install` to a
   temporary name and renames it. The key goes first. The volume is read-only
   in the relay. The helper deletes copies of an earlier, wider certificate.
5. **PEM parsing** uses the `PemObject` API of `rustls-pki-types`. The
   unmaintained `rustls-pemfile` (RUSTSEC-2025-0134) is removed.

## Consequences

- A leak from the relay process exposes the DERP key, the gateway secret and
  the `*.<SERVICE_DOMAIN>` key. It does not expose the control key, the admin
  key, or any certificate for tailnet addresses, `APP_DOMAIN`,
  `CONTROL_DOMAIN` or `DERP_DOMAIN`.
- Existing service names `<name>.<BASE_DOMAIN>` stop working with HTTPS. They
  needed the control-plane wildcard, so they cannot stay. The same name is now
  `<name>.<SERVICE_DOMAIN>`. Board links change automatically. Names without
  HTTPS (no `port`) stay `<name>.<BASE_DOMAIN>`: they need no certificate.
- `DERP_DOMAIN` is required in the compose stack. A one-shot `relay-keys`
  service moves `derp.key` and `gateway.key` to the relay volume, so each
  tailnet keeps its gateway node.
- A tailnet that already holds the address `svc` keeps it. Device names under
  it (`<device>.svc.<BASE_DOMAIN>`) can collide with service names. Rename
  such a tailnet before the upgrade.

## Follow-up

- Least-privilege PostgreSQL role for a relay with a gateway. The relay now
  uses the owner role of the coordinator tables, because the gateway registers
  nodes and writes tenant configuration (`scripts/relay-db-role.sql`).
- A real-client test (ADR-0029) with the new names.
