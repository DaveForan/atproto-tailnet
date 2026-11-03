# ADR-0006: Custom DERP relay and IP range configuration

**Status:** Accepted
**Date:** 2026-11-02

## Context

Tenants need network customization beyond Headscale's defaults. Three areas
drive this:

1. **Custom relay regions** — some tenants need DERP relays in specific
   geographic regions for latency or data-residency compliance. Headscale
   supports loading DERP maps from YAML path files, but there is no
   per-tenant abstraction in the service layer.

2. **IP range isolation** — by default all tenants share Headscale's
   built-in 100.64.0.0/10 and fd7a:115c:a1e0::/48 prefixes. Tenants with
   overlapping use-cases (e.g., multiple staging environments) or compliance
   constraints need distinct CIDR prefixes so their address spaces never
   collide.

3. **Allocation strategy** — sequential allocation is predictable and easy
   to audit; random allocation reduces information leakage about network
   size. Different tenants have different preferences.

## Decision

### Custom DERP regions

Per-tenant DERP region definitions are stored in the tenant row (JSONB
`derpRegions` column). Region IDs are constrained to 900-999 to avoid
collision with Tailscale's public relay IDs.

On write, `writeDerpRegionsFile()` in `orchestrator/headscale.ts` generates
a YAML paths file at `<data-dir>/<tenant-slug>/derp-custom.yaml` and
references it in the tenant's Headscale `config.yaml`. Headscale hot-reloads
DERP path files every 5 minutes — no container restart required.

Two additional toggles are stored on the tenant:

- **`embeddedDerpEnabled`** — runs the DERP relay inside the Headscale
  container itself. Changing this value requires a container restart
  (applied via `updateInstanceConfig()` + restart).
- **`publicDerpEnabled`** — controls whether the tenant's Headscale
  instance uses Tailscale's public DERP relays as a fallback.

All DERP configuration is gated by the `manage_acl` permission. Changes are
audit-logged.

### Per-tenant IP ranges

The tenant row stores four additional columns:

- `ipv4Prefix` — CIDR prefix for IPv4 allocation (default: 100.64.0.0/10)
- `ipv6Prefix` — CIDR prefix for IPv6 allocation (default: fd7a:115c:a1e0::/48)
- `allocationStrategy` — enum: `sequential` (default) or `random`

On write, `updateInstanceConfig()` rewrites the tenant's Headscale
`config.yaml` with the new prefixes and strategy. Because Headscale reads
IP configuration only at startup, the container is restarted after any
change.

IP range configuration is gated by the `manage_settings` permission.
Changes are audit-logged.

### API surface

- `GET /api/tenants/:id/derp` — returns current DERP regions, embedded toggle, public relay toggle
- `PUT /api/tenants/:id/derp` — updates DERP configuration (manage_acl)
- `GET /api/tenants/:id/ip-config` — returns current IP prefixes and allocation strategy
- `PUT /api/tenants/:id/ip-config` — updates IP configuration (manage_settings, triggers restart)

## Consequences

- DERP region changes are **eventually consistent** — up to 5 minutes for
  Headscale to reload the paths file. The API returns success immediately
  but the effect is delayed.
- Embedded DERP toggle changes require a **container restart**, causing a
  brief connectivity interruption for all devices in the tenant's tailnet.
- IP prefix/strategy changes are **destructive** — they require a container
  restart and all existing devices must re-register to receive addresses from
  the new range. The API warns about this in its response.
- Region IDs 900-999 cap custom regions at 100 per tenant, which is
  sufficient for foreseeable use-cases.
- DERP YAML files are written to the tenant's data directory, tying
  configuration to the filesystem layout established in ADR-0002.
