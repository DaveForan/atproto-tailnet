# ADR-0040: Remove the Headscale mode

**Status:** Accepted
**Date:** 2026-11-26
**Priority:** P1
**Depends On:** ADR-0023 (Rust mesh coordinator), ADR-0039 (every new device waits for admission)
**Related:** ADR-0001 (Headscale as control plane), ADR-0002 (container per tenant), ADR-0035 (device-bound access), ADR-0036 (device visibility), ADR-0029 (gateway node), ADR-0020 (federation relay data plane)

## Context

The service had two control planes. The first was one Headscale Docker
container for each tailnet, which the service managed through the Docker
socket (ADR-0001, ADR-0002). The second is the Rust coordinator (ADR-0023).

Two control planes cost every feature a second path:

- Each route handler and orchestrator module had a branch for each mode.
- Each test had to cover the two modes.
- The Headscale path needed the Docker socket, which is root-equivalent on
  the host.

The newer security features exist only on the coordinator: device admission
(ADR-0039), per-member device access (ADR-0036), the machine lock (ADR-0035)
and the gateway (ADR-0029). An instance in Headscale mode did not have them,
and the older flows in that mode were weaker.

Production runs the coordinator. No known instance runs the Headscale mode.

## Decision

The Rust coordinator is the only control plane. The Headscale mode is removed.

1. **Configuration.** `COORDINATOR_URL` and `COORDINATOR_API_KEY` are
   required. The service refuses to start without them. The variables
   `HEADSCALE_IMAGE`, `HEADSCALE_PORT_RANGE_START`, `HEADSCALE_PORT_RANGE_END`
   and `HEADSCALE_DATA_DIR` are removed. `HEADSCALE_NETWORK` becomes
   `FEDERATION_RELAY_NETWORK`.
2. **Tenant containers.** The service creates no Headscale container. The
   Docker lifecycle code, the Headscale REST client, the Headscale config and
   DERP YAML writers, and the port allocator (10001-10100) are removed.
3. **Tenant start, stop and hibernation.** `POST /api/tenants/:id/start` and
   `/stop` are removed. The setting `hibernateAfterDays` and the field
   `lastActivityAt` are removed.
4. **Key-request approvals.** The `device_approvals` table and all
   `/api/tenants/:id/device-approvals*` routes are removed. The auth-key
   endpoint no longer answers `approval_required`. Device admission
   (ADR-0039) is the only flow.
5. **Headscale device locks.** The `device_locks` table, all
   `/api/tenants/:id/device-locks*` routes and the `lock_devices` permission
   are removed. 16 permissions stay. The machine lock and the account device
   lock (ADR-0035) stay.
6. **DERP.** The embedded DERP toggle (`embeddedDerpEnabled`) is removed.
   Custom DERP regions for each tailnet stay. The service pushes them to the
   coordinator.
7. **IP ranges.** `PUT /api/tenants/:id/ip-config` is removed. The ranges are
   fixed at creation. `GET` stays and returns `{ipv4Prefix, ipv6Prefix}`.
8. **API fields.** `coordinatorMode` (in `/api/me` and tenant objects) and
   the `supported` flags (`boards/my-devices`, `access-mode`,
   `device-approval/mine`, `machine-lock`) are removed. In `GET .../devices`,
   a device has `owner: {userId, handle} | null`, and each `byUser` group has
   `key` (the owner's user id, or `unassigned`) in place of `hsUsername`.
   `GET .../acl` returns `{policy}` and `PUT .../acl` takes `{acls, hosts}`.
   `GET .../members` no longer returns `isLocked`.
9. **Control client.** `orchestrator/control-client.ts` exports only
   `getCoordinatorClient(tenant?)`. `orchestrator/control-types.ts` holds the
   shared types (`ControlNode`, `ControlPreAuthKey`, `ControlRoute`).
10. **Health monitor.** The monitor restarts nothing. It checks the
    coordinator. It sends the per-tenant state again when the `boot_id` of
    the coordinator changes.
11. **Compose files.** `docker-compose.yml`, `docker-compose.production.yml`
    and `Caddyfile.production` are deleted. `docker-compose.coordinator.yml`
    is the production stack and `docker-compose.coordinator.dev.yml` is the
    local development stack. The names do not change, because the deploy
    scripts and the production server use them.

The format of the ACL policy stays the Headscale policy format (`acls`,
`hosts`). The coordinator refuses groups, tags and `autoApprovers` as before.

## Consequences

- A standard instance needs no Docker socket for the service. Only the
  federation relay halves (ADR-0020, `orchestrator/relay.ts`) use Docker, and
  only with `FEDERATION_ENABLED=true`. Federation is off by default and
  deferred (ADR-0033).
- `COORDINATOR_URL` and `COORDINATOR_API_KEY` are required in each
  environment, also in local development.
- Drizzle migration `0045_remove_headscale_mode.sql` drops the tables
  `device_locks` and `device_approvals`. It drops the columns
  `tenants.port`, `tenants.api_key`, `tenants.container_id`,
  `tenants.embedded_derp_enabled`, `tenants.hibernate_after_days`,
  `tenants.last_activity_at`, `tenants.ip_allocation`, `tenants.plan_name`
  and `auth_keys.hs_username`. It removes `lock_devices` from stored role
  permissions. The migration is destructive for these unused tables and
  columns. Tailnets, members and devices that exist are not affected.
- The migration is not safe for a rolling deploy. An old service process
  reads the dropped columns on each tailnet lookup and fails after the
  migration. Stop all old service processes before the migration runs. The
  compose stack does this already (one app process, replaced at once). For
  Kubernetes, `deploy/kubernetes/README.md` gives the order: scale the app to
  zero, migrate, then start the new version.
- An instance that still runs the Headscale mode cannot upgrade without
  moving its devices to the coordinator. There is no migration tool. Each
  device must register again with the coordinator.
- Each feature has one path. The tests cover one control plane.
- ADR-0001 and ADR-0002 are history. ADR-0023 superseded them.

## Acceptance

- The service refuses to start without `COORDINATOR_URL` or
  `COORDINATOR_API_KEY`.
- The compose stack starts with no Docker socket mount in the app service.
- The removed routes answer 404.
- After migration 0045, the number of users, tailnets, members and devices
  is the same as before.
