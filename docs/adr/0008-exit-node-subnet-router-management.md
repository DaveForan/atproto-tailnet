# ADR-0008: Exit node and subnet router management

**Status:** Accepted
**Date:** 2026-11-02

## Context

Tailscale devices can advertise routes to the network. Subnet routers
expose specific CIDR ranges (for example, 192.168.1.0/24 for a home LAN).
Exit nodes advertise the default route (0.0.0.0/0 and ::/0) and tunnel all
traffic through themselves. In Headscale, an advertised route stays in a
"pending" state until an administrator enables it.

The atproto-tailnet dashboard must show these advertised routes. It must
let authorized members approve, reject, or remove them. Headscale already
manages route state, and the dashboard must not implement it again.

## Decision

### Thin wrapper over Headscale route API

The route management feature is a pass-through layer over the existing
Headscale route REST API. The service does not store route state in its own
database. Headscale is the single source of truth. It knows which routes
exist, which routes are enabled, and which devices advertise them.

### Route listing

`GET /api/tenants/:id/routes` queries the Headscale instance of the tenant
for all routes. It splits the response into two categories:

- **Exit nodes**: routes where the prefix is `0.0.0.0/0` or `::/0`
- **Subnets**: all other advertised CIDR prefixes

Each route entry includes these fields: the Headscale route ID, the name and ID
of the advertising device, the prefix, and the current enabled state.

### Route actions

The service supports three actions. Each action targets one route by its
Headscale route ID:

- `POST /api/tenants/:id/routes/:routeId/enable` — enables a pending or
  disabled route
- `POST /api/tenants/:id/routes/:routeId/disable` — disables an active
  route
- `DELETE /api/tenants/:id/routes/:routeId` — permanently removes a route
  advertisement

### Permission gating

The `manage_devices` permission gates all route management endpoints. This
follows the principle that route approval is an administrative action on
devices. Originators pass this check without conditions because of the
`isOriginator` short-circuit.

### Audit trail

The system records every enable, disable, and delete action in the `audit_logs`
table. The actions are `route_enabled`, `route_disabled`, and `route_deleted`.
The audit entry includes the route ID, the prefix, and the name of the
advertising device for traceability.

### API surface

- `GET /api/tenants/:id/routes` — returns `{ exitNodes: [...], subnets: [...] }`
- `POST /api/tenants/:id/routes/:routeId/enable` — enable a route (manage_devices)
- `POST /api/tenants/:id/routes/:routeId/disable` — disable a route (manage_devices)
- `DELETE /api/tenants/:id/routes/:routeId` — delete a route (manage_devices)

## Consequences

- **Route state lives only in Headscale**: the service has no local
  cache or mirror of route data. If Headscale is unreachable, route listing
  and management fail. There is no offline or degraded-mode fallback.
- **No route creation**: Tailscale clients advertise routes on
  devices. The admin API does not create routes. This service only manages
  (approves, rejects, or removes) routes that devices already advertise.
- **The audit trail provides accountability**: route state is not in our
  DB, so the audit log is the only record of who approved or removed a route
  and when. This is critical for compliance and incident response.
- **The split between exit nodes and subnets is for presentation only**:
  Headscale treats all routes the same way. The split is a UI feature. It
  helps administrators to distinguish "tunnel all traffic" from "expose a
  specific network."
- **Route IDs are internal to Headscale**: they are opaque integers. They can
  change when a device advertises a route again. The audit log records the
  prefix and device name with the ID. The history stays readable even if
  Headscale reuses IDs.
