# ADR-0008: Exit node and subnet router management

**Status:** Accepted
**Date:** 2026-11-02

## Context

Tailscale devices can advertise routes to the network: subnet routers
expose specific CIDR ranges (e.g., 192.168.1.0/24 for a home LAN), and
exit nodes advertise the default route (0.0.0.0/0 and ::/0) to tunnel all
traffic through themselves. In Headscale, advertised routes exist in a
"pending" state until an administrator explicitly enables them.

The atproto-tailnet dashboard needs to surface these advertised routes and
let authorized members approve, reject, or remove them — without
reimplementing route state management that Headscale already handles.

## Decision

### Thin wrapper over Headscale route API

Route management is implemented as a pass-through layer over Headscale's
existing route REST API. The service does not store route state in its own
database — Headscale is the single source of truth for which routes exist,
which are enabled, and which devices advertise them.

### Route listing

`GET /api/tenants/:id/routes` queries the tenant's Headscale instance for
all routes and splits the response into two categories:

- **Exit nodes** — routes where the prefix is `0.0.0.0/0` or `::/0`
- **Subnets** — all other advertised CIDR prefixes

Each route entry includes its Headscale route ID, the advertising device's
name and ID, the prefix, and whether it is currently enabled.

### Route actions

Three actions are supported, each targeting a specific route by its
Headscale route ID:

- `POST /api/tenants/:id/routes/:routeId/enable` — enables a pending or
  disabled route
- `POST /api/tenants/:id/routes/:routeId/disable` — disables an active
  route
- `DELETE /api/tenants/:id/routes/:routeId` — permanently removes a route
  advertisement

### Permission gating

All route management endpoints are gated by the `manage_devices` permission,
consistent with the principle that route approval is a device-level
administrative action. Originators pass this check unconditionally via the
`isOriginator` short-circuit.

### Audit trail

Every enable, disable, and delete action is recorded in the `audit_logs`
table with actions `route_enabled`, `route_disabled`, and `route_deleted`
respectively. The audit entry includes the route ID, prefix, and
advertising device name for traceability.

### API surface

- `GET /api/tenants/:id/routes` — returns `{ exitNodes: [...], subnets: [...] }`
- `POST /api/tenants/:id/routes/:routeId/enable` — enable a route (manage_devices)
- `POST /api/tenants/:id/routes/:routeId/disable` — disable a route (manage_devices)
- `DELETE /api/tenants/:id/routes/:routeId` — delete a route (manage_devices)

## Consequences

- **Route state lives entirely in Headscale** — the service has no local
  cache or mirror of route data. If Headscale is unreachable, route listing
  and management fail. There is no offline or degraded-mode fallback.
- **No route creation** — routes are advertised by Tailscale clients on
  devices, not created through the admin API. This service only manages
  (approves/rejects/removes) routes that devices have already advertised.
- **Audit trail provides accountability** — since route state is not in our
  DB, the audit log is the only record of who approved or removed a route
  and when. This is critical for compliance and incident response.
- **Exit node vs. subnet split is presentation-only** — Headscale treats
  all routes uniformly. The split is a UI convenience that helps
  administrators distinguish between "tunnel all traffic" and "expose a
  specific network."
- **Route IDs are Headscale-internal** — they are opaque integers that may
  change if a device re-advertises a route. The audit log captures the
  prefix and device name alongside the ID to maintain human-readable
  history even if IDs are recycled.
