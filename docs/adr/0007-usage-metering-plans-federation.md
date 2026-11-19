# ADR-0007: Usage metering, plan limits, and federation

**Status:** Accepted
**Date:** 2026-11-02

## Context

A multi-tenant service needs resource tracking. atproto-tailnet needs it for
billing readiness and operational visibility. Tenants must see their
current usage. Administrators must set guardrails at plan level. The
platform needs historical data for capacity planning.

Independent tailnets also exist, and different originators manage them.
These originators need a way to establish trust relationships. The trust
relationship allows controlled connectivity between the networks, and the
networks do not merge. This is the "federation" use-case. Two organizations
collaborate, but each organization keeps sovereignty over its own tailnet.

## Decision

### Usage metering

The background health monitor (see `orchestrator/monitor.ts`) already runs
a 60-second tick loop for each running tenant. On every 5th tick (~5
minutes), it records a usage snapshot. It queries the Headscale instance of
the tenant for these values:

- `deviceCount`: total registered nodes
- `onlineCount`: nodes that are connected now
- `memberCount`: memberships in our DB
- `routeCount`: advertised routes (exit nodes and subnets)

The system stores snapshots in a `usage_snapshots` table with the key `(tenantId,
recordedAt)`. The API returns the most recent 168 entries (7 days at
5-minute intervals). The dashboard uses them for sparklines and trend display.

### Plan limits

Three columns on the `tenants` table store the plan configuration:

- `planName`: free-text label (for example, "free", "team", "enterprise")
- `maxDevices`: nullable integer limit for registered devices
- `maxMembers`: nullable integer limit for memberships

When a snapshot records counts above a limit, the API response
includes an `exceeded` flag and a warning message. Plan limits are
**advisory, not blocking**. The system does not refuse new device
registrations or member invitations when counts exceed the limits. This
prevents disruptive enforcement, and originators can still see the usage.

The originator sets the plan configuration with `PUT /api/tenants/:id/plan`.
A permission does not gate this endpoint, because plan changes are
infrastructure-level.

### Federation

Federation establishes bidirectional trust links between two tenants. The
lifecycle has these steps:

1. **Request**: the originator of tenant A creates a federation link for
   the slug of tenant B. The originator declares the CIDR ranges that tenant A shares.
2. **Accept**: the originator of tenant B accepts the request and declares the
   CIDR ranges that tenant B shares. The link status becomes `active`.
3. **Reject**: the originator of tenant B rejects the request. The link status
   becomes `rejected`.
4. **Revoke**: either side can revoke an active link at any time. The link
   status becomes `revoked`.

The `federation_links` table stores federation links. It has these columns:

- `requestorTenantId`, `targetTenantId`: the two parties
- `requestorCidrs`, `targetCidrs`: JSONB arrays of the CIDR strings that each side shares
- `status`: enum: `pending`, `active`, `rejected`, `revoked`

The `manage_settings` permission controls federation management. The system
writes all lifecycle transitions to the audit log.

### API surface

- `GET /api/tenants/:id/usage` — live counts + plan limits + 7-day snapshot history
- `PUT /api/tenants/:id/plan` — set plan name, max devices, max members (originator only)
- `GET /api/tenants/:id/federation` — list federation links (inbound and outbound)
- `POST /api/tenants/:id/federation` — create a federation request
- `POST /api/tenants/:id/federation/:linkId/accept` — accept a pending request
- `POST /api/tenants/:id/federation/:linkId/reject` — reject a pending request
- `POST /api/tenants/:id/federation/:linkId/revoke` — revoke an active link

## Consequences

- **Usage data grows linearly**: ~288 rows for each tenant each day. We need a
  retention policy (for example, downsample to hourly after 30 days, delete
  after 90 days) before the table causes performance problems. This
  iteration does not implement it.
- **Federation works at the management layer only**: the `federation_links`
  table records intent and trust. Actual cross-network routing needs shared
  relay devices or subnet routers that we configure in both tailnets.
  Federation does not establish connectivity automatically.
- **Plan enforcement is advisory**: the dashboard and API show warnings when
  counts exceed limits, but they do not block operations. We can add hard
  enforcement later without schema changes (check the counts before
  device or member creation).
- **The snapshot interval is fixed at 5 minutes**: this is enough for the
  dashboard, but too coarse for billing-grade metering. A future billing
  integration needs a separate event stream with higher fidelity.
- **Federation CIDR declarations are self-reported**: the system does not
  check that the declared CIDRs match the actual IP ranges of the tenant.
  The originator is responsible for correct configuration.
