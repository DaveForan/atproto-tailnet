# ADR-0006: Custom DERP relay and IP range configuration

**Status:** Accepted
**Date:** 2026-11-02

## Context

Tenants need network customization beyond the Headscale defaults. Three
areas drive this need:

1. **Custom relay regions**: some tenants need DERP relays in specific
   geographic regions for latency or data-residency compliance. Headscale
   can load DERP maps from YAML path files. The service layer has no
   abstraction for each tenant.

2. **IP range isolation**: by default, all tenants share the built-in
   Headscale prefixes 100.64.0.0/10 and fd7a:115c:a1e0::/48. Some tenants
   have overlapping use-cases (for example, multiple staging environments)
   or compliance constraints. These tenants need distinct CIDR prefixes
   so their address spaces never collide.

3. **Allocation strategy**: sequential allocation is predictable and easy
   to audit. Random allocation reveals less information about the network
   size. Different tenants prefer different strategies.

## Decision

### Custom DERP regions

The tenant row stores the DERP region definitions for each tenant (JSONB
`derpRegions` column). Region IDs are limited to 900-999. This prevents
collision with the public relay IDs of Tailscale.

On write, `writeDerpRegionsFile()` in `orchestrator/headscale.ts` generates
a YAML paths file at `<data-dir>/<tenant-slug>/derp-custom.yaml`. It then
references the file in the Headscale `config.yaml` of the tenant. Headscale
hot-reloads DERP path files every 5 minutes. The container does not need a restart.

The tenant stores two more toggles:

- **`embeddedDerpEnabled`**: runs the DERP relay inside the Headscale
  container. A change to this value needs a container restart
  (the system applies it with `updateInstanceConfig()` and a restart).
- **`publicDerpEnabled`**: controls if the Headscale instance of the
  tenant uses the public DERP relays of Tailscale as a fallback.

The `manage_acl` permission controls all DERP configuration. The system
writes each change to the audit log.

### Per-tenant IP ranges

The tenant row stores three more columns:

- `ipv4Prefix`: CIDR prefix for IPv4 allocation (default: 100.64.0.0/10)
- `ipv6Prefix`: CIDR prefix for IPv6 allocation (default: fd7a:115c:a1e0::/48)
- `allocationStrategy`: enum: `sequential` (default) or `random`

On write, `updateInstanceConfig()` rewrites the Headscale `config.yaml` of
the tenant with the new prefixes and strategy. Headscale reads the IP
configuration only at startup. Because of this, the system restarts the container
after each change.

The `manage_settings` permission controls IP range configuration.
The system writes each change to the audit log.

### API surface

- `GET /api/tenants/:id/derp` — returns current DERP regions, embedded toggle, public relay toggle
- `PUT /api/tenants/:id/derp` — updates DERP configuration (manage_acl)
- `GET /api/tenants/:id/ip-config` — returns current IP prefixes and allocation strategy
- `PUT /api/tenants/:id/ip-config` — updates IP configuration (manage_settings, triggers restart)

## Consequences

- DERP region changes are **eventually consistent**. Headscale needs up to
  5 minutes to reload the paths file. The API returns success immediately,
  but the effect is delayed.
- A change to the embedded DERP toggle needs a **container restart**. All
  devices in the tailnet of the tenant lose connectivity for a short time.
- IP prefix and strategy changes are **destructive**. They need a container
  restart. All existing devices must register again to receive addresses from
  the new range. The API response includes a warning about this.
- Region IDs 900-999 limit the custom regions to 100 for each tenant. This
  limit is enough for the use-cases we foresee.
- The system writes DERP YAML files to the data directory of the tenant.
  This ties the configuration to the filesystem layout from ADR-0002.
