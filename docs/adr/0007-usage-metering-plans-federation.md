# ADR-0007: Usage metering, plan limits, and federation

**Status:** Accepted
**Date:** 2026-11-02

## Context

As a multi-tenant service, atproto-tailnet needs resource tracking for
billing readiness and operational visibility. Tenants need to understand
their current usage, administrators need to set plan-level guardrails, and
the platform needs historical data for capacity planning.

Separately, independent tailnets managed by different originators need a way
to establish trust relationships — allowing controlled connectivity between
networks without merging them. This is the "federation" use-case: two
organizations that collaborate but each retain sovereignty over their own
tailnet.

## Decision

### Usage metering

The background health monitor (see `orchestrator/monitor.ts`) already runs
a 60-second tick loop against every running tenant. Every 5th tick (~5
minutes), it records a usage snapshot by querying the tenant's Headscale
instance for:

- `deviceCount` — total registered nodes
- `onlineCount` — nodes currently connected
- `memberCount` — memberships in our DB
- `routeCount` — advertised routes (exit nodes + subnets)

Snapshots are stored in a `usage_snapshots` table keyed by `(tenantId,
recordedAt)`. The API returns the most recent 168 entries (7 days at
5-minute intervals) for dashboard sparklines and trend display.

### Plan limits

Three columns on the `tenants` table track plan configuration:

- `planName` — free-text label (e.g., "free", "team", "enterprise")
- `maxDevices` — nullable integer cap on registered devices
- `maxMembers` — nullable integer cap on memberships

When a snapshot records counts that exceed a limit, the API response
includes an `exceeded` flag and a warning message. Plan limits are
**advisory, not blocking** — the system does not refuse new device
registrations or member invitations when limits are exceeded. This avoids
disruptive enforcement while giving originators visibility.

Plan configuration is set via `PUT /api/tenants/:id/plan`, gated by the
originator (not a permission — plan changes are infrastructure-level).

### Federation

Federation establishes bidirectional trust links between two tenants. The
lifecycle is:

1. **Request** — originator of tenant A creates a federation link targeting
   tenant B's slug, declaring which CIDR ranges tenant A will share.
2. **Accept** — originator of tenant B accepts the request, declaring their
   own shared CIDR ranges. Link status becomes `active`.
3. **Reject** — originator of tenant B rejects the request. Link status
   becomes `rejected`.
4. **Revoke** — either side can revoke an active link at any time. Link
   status becomes `revoked`.

Federation links are stored in a `federation_links` table with columns:

- `requestorTenantId`, `targetTenantId` — the two parties
- `requestorCidrs`, `targetCidrs` — JSONB arrays of CIDR strings each side shares
- `status` — enum: `pending`, `active`, `rejected`, `revoked`

Federation management is gated by the `manage_settings` permission. All
lifecycle transitions are audit-logged.

### API surface

- `GET /api/tenants/:id/usage` — live counts + plan limits + 7-day snapshot history
- `PUT /api/tenants/:id/plan` — set plan name, max devices, max members (originator only)
- `GET /api/tenants/:id/federation` — list federation links (inbound and outbound)
- `POST /api/tenants/:id/federation` — create a federation request
- `POST /api/tenants/:id/federation/:linkId/accept` — accept a pending request
- `POST /api/tenants/:id/federation/:linkId/reject` — reject a pending request
- `POST /api/tenants/:id/federation/:linkId/revoke` — revoke an active link

## Consequences

- **Usage data grows linearly** — ~288 rows per tenant per day. A retention
  policy (e.g., downsample to hourly after 30 days, delete after 90) is
  needed before the table becomes a performance concern. Not implemented in
  this iteration.
- **Federation is management-layer only** — the `federation_links` table
  records intent and trust, but actual cross-network routing requires shared
  relay devices or subnet routers configured in both tailnets. Federation
  does not automatically establish connectivity.
- **Plan enforcement is advisory** — exceeded limits surface warnings in the
  dashboard and API but do not block operations. Hard enforcement can be
  layered on later without schema changes (check counts before
  device/member creation).
- **Snapshot granularity is fixed at 5 minutes** — sufficient for dashboard
  display but too coarse for billing-grade metering. A future billing
  integration would need a separate, higher-fidelity event stream.
- **Federation CIDR declarations are self-reported** — the system does not
  validate that the declared CIDRs match the tenant's actual IP ranges.
  Misconfiguration is the originator's responsibility.
