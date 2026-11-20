# ADR-0028: Coordinator DNS — extra records and split DNS

**Status:** In Progress
**Date:** 2026-11-19
**Priority:** P1
**Depends On:** ADR-0023 (Rust mesh coordinator), ADR-0026 (tailnet addresses)

## Context

The coordinator sends an empty DNS configuration in the netmap. Thus:

- Device names (MagicDNS) do not resolve. Users must use 100.x addresses.
- The coordinator cannot give names to services (ADR-0030).

The Tailscale netmap `DNSConfig` has these fields that are relevant:

- `ExtraRecords`: a list of name → IP records (A or AAAA).
- `Routes`: a map from DNS suffix to resolvers ("split DNS").
- `Proxied`: turns on MagicDNS for device names.
- `CertDomains`: names for which the control server helps with certificates.

The Tailscale client source shows an important behavior. If a route has an
**empty** resolver list, the client adds the suffix to its local domains. For a
name under a local domain with no matching record, the client resolver returns
**NXDOMAIN** and does not forward the query. (Reference:
`net/dns/manager.go`, `compileConfig`; `net/dns/resolver/tsdns.go`,
`resolveLocal`.)

Thus, if the coordinator claims `BASE_DOMAIN` with an empty route, every other
name under `BASE_DOMAIN` stops resolving on tailnet devices. This includes any
control URL under that suffix. Devices could lose contact with the coordinator.

## Decision

### 1. Per-tenant DNS configuration

The coordinator keeps a per-tenant DNS configuration in memory: extra records
and split-DNS routes. The TS service is the source of truth. It pushes the
configuration with `PUT /api/tenants/{id}/dns` and replays it when the
coordinator restarts. This is the same pattern as identity, DERP and
auto-approvers.

### 2. Split DNS with upstream resolvers

The route for `BASE_DOMAIN` always has upstream resolvers. It is never empty.
The client answers names that have an extra record. It forwards all other names
to the upstream resolvers.

The control URL is not under `BASE_DOMAIN` (ADR-0026). Legacy control hostnames
under `BASE_DOMAIN` get an explicit extra record to the public IP.

The coordinator never sets global resolvers. The normal DNS of members does not
change.

### 3. Device names (MagicDNS)

The coordinator names each device `<device>.<tailnet-name>.<BASE_DOMAIN>` and
adds an extra record for it. `<tailnet-name>` is the primary public name
(ADR-0026). Two tailnets can each have a device called `laptop`.

Short names (`http://laptop`) use the search-domain field.

### 4. Size limits

The coordinator limits the number of records per tenant and the length of
names. Input validation is the same as for the identity registry.

## Consequences

- Device names and service names resolve inside the tailnet only.
- Members keep their normal DNS for all other names.
- Device names under the tailnet name are visible to members only. They are not
  in public DNS and not in certificate logs.

## Acceptance

- On the Mac and on a phone, a device name resolves to the 100.x address of the
  device.
- A name under `BASE_DOMAIN` without a record resolves through public DNS.
- The control URL resolves on all devices after the change.
- Rust tests cover netmap DNS output. A test confirms that the route for
  `BASE_DOMAIN` is never empty.

## Implementation notes

Built: the stored per-tenant configuration and its admin API, device names
under the tailnet name with MagicDNS and a search domain, service records sent
only to the devices that may see them, and the compilation of names in the TS
service.

Difference from the decision: the route for `BASE_DOMAIN` is optional. With
`TAILNET_DNS_UPSTREAM` empty (the default), the coordinator sends no route. The
client then answers the records itself and forwards other names to the
resolvers of the device. No third-party resolver is necessary. With upstream
resolvers set, the coordinator sends the split-DNS route. It never sends an
empty route.

Not yet done: a check on real devices (macOS, iOS, Android, Linux) that device
names and service names resolve and that other names still resolve.
