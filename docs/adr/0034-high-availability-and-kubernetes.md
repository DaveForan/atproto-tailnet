# ADR-0034: High availability, replicas, and Kubernetes

**Status:** In Progress
**Date:** 2026-11-20
**Priority:** P1
**Depends On:** ADR-0023 (Rust mesh coordinator), ADR-0026 (shared control URL), ADR-0027 (DERP relay)

## Context

The production instance is one Droplet with one container of each component:
dashboard and API (TS service), coordinator, relay (inside the coordinator),
PostgreSQL and Caddy. If the Droplet stops, sign-in, device registration and
relayed traffic all stop. Devices with a direct path keep their connection
until their keys or netmap change.

The operator wants to run the stack on Kubernetes as well as on Docker, with
more than one replica of the coordinator, the dashboard and the relay.

The components cannot run as replicas today. Each keeps state in one process:

**Coordinator**

- Per-tenant configuration lives in memory: ACL policy, DERP regions,
  auto-approvers, identity names (and DNS, ADR-0028). The TS service pushes it
  and replays it after a restart. A second replica would not receive it.
- Peer events (node joined, updated, offline) use an in-process broadcast
  channel, also with the PostgreSQL store. A device that polls replica A does
  not learn about a device that registered at replica B.
- Rate limiters, the replay guard and connection limits are per process.

**Relay**

- The table of connected clients is in the process. Two devices on different
  replicas cannot exchange packets.
- The coordinator tells each device that all peers use the home region of the
  tenant. It does not record the real home relay of a device.

**TS service**

- `withTailnetCreationLock` is an in-process queue.
- The monitor, the federation broker and the sweeps run in every process. Two
  replicas would do the work two times.
- Rate limits are in memory. The MCP loopback secret is random per process.
- The service writes Caddy routes through the Caddy admin API.

## Decision

Make each component correct with N replicas, in three stages. Docker Compose
stays a supported deployment with one replica of each component.

### Stage A: shared state (no topology change)

1. **Coordinator configuration in the database.** ACL policy, DERP regions,
   auto-approvers, identity and DNS move to tables that the coordinator reads.
   The admin API writes them. The in-memory registries become caches. The TS
   service stops the replay after a restart.
2. **Event bus.** Peer events and configuration changes go through PostgreSQL
   `LISTEN/NOTIFY`. Each replica listens and feeds its local broadcast channel.
   The payload is small (tenant ID, node ID, event type). The replica reads the
   data from the database. SQLite and memory backends keep the in-process
   channel (single replica only).
3. **TS service locks.** Tailnet creation uses a PostgreSQL advisory lock. The
   monitor, broker, outbox and sweeps run only on the replica that holds a
   leader advisory lock. If the leader stops, another replica takes the lock.
4. **Shared secrets and limits.** The MCP loopback secret derives from
   `SESSION_SECRET`. Rate limits use a PostgreSQL store, or stay per replica
   with a documented lower bound.

### Stage B: roles and relay regions

1. **Roles.** The coordinator binary gets a role: `control`, `relay`, or `all`
   (default). A `relay` process serves `/derp` and STUN and reads the store for
   admission. It does not serve the control protocol or the admin API.
2. **One region per relay replica.** Each relay replica has its own hostname
   and its own DERP region. A Tailscale client connects to the home region of
   the peer to send to it. Thus two devices on different relays can exchange
   packets with no mesh between relays. A relay that stops loses only its
   region; clients move to another region.
3. **Real home relay.** The coordinator records the preferred relay that each
   device reports (`NetInfo.PreferredDERP`) and sends it to peers as the home
   relay of that device.
4. **Relay discovery.** Relay replicas register in a database table (hostname,
   region ID, last seen). The default DERP map is built from live rows.

### Stage C: Kubernetes

1. Manifests in `deploy/kubernetes/` (Kustomize base and overlays): Deployments
   for the TS service and the coordinator (`control`), a StatefulSet for relays
   (stable names → stable hostnames and regions), Services, and an Ingress or
   Gateway for the dashboard, the control URL and the relay hostnames.
2. TLS from cert-manager (DNS-01 wildcard). Caddy is optional: when
   `CADDY_ADMIN_URL` is not set, the TS service does not write routes. With the
   shared control URL (ADR-0026), only legacy tailnet hostnames need dynamic
   routes.
3. STUN through a UDP LoadBalancer Service per relay, or host ports.
4. The Noise control key and the relay keys come from Secrets. All control
   replicas use the same control key.
5. PostgreSQL is outside these manifests: a managed service, or an operator
   such as CloudNativePG. The documentation gives both options.
6. Readiness and liveness probes use `/health`. A PodDisruptionBudget keeps one
   replica of each component during node maintenance. The long-poll map
   connections end on a pod restart; clients connect again to another replica.

## Consequences

- Loss of one replica does not stop sign-in, registration or relayed traffic.
- PostgreSQL becomes the one stateful dependency, and must itself be highly
  available.
- The coordinator restart no longer needs a replay from the TS service.
- More regions are possible later with the same relay design.
- Stage A is a prerequisite for all other stages and changes several
  registries that were built in this cycle (identity, DERP, auto-approvers).

## Acceptance

- Two coordinator replicas: a device registered at one appears in the netmap of
  a device that polls the other, in less than 2 seconds.
- Two relay replicas: devices with different home relays exchange packets.
- Stopping one replica of any component during a ping between two devices
  loses no more than a few seconds of traffic.
- Two TS service replicas: the monitor runs one time per interval.
- `kubectl apply -k deploy/kubernetes/overlays/example` gives a working
  instance on a test cluster. Docker Compose continues to work.

## Implementation notes

Built (stage A, item 3):

- `db/locks.ts`: `withAdvisoryLock` and `LeaderLock` on PostgreSQL session
  advisory locks.
- Tailnet creation holds an advisory lock across all replicas.
- The monitor (health checks, hibernation, Caddy sync, identity sync, sweeps)
  and the federation broker run only on the replica that holds the leader
  lock. Another replica takes the lock in 10 seconds or less when the leader
  stops.

Difference from the decision: the MCP loopback secret stays random for each
process. An MCP tool calls the API of its own process, so replicas do not
share the secret.

Not yet built: coordinator configuration in the database for ACL policy, DERP
regions, auto-approvers and identity (access rules, DNS and machine locks are
in the database already); the LISTEN/NOTIFY event bus; shared rate limits;
pending device sign-ins in the store; stage B and stage C.

Not yet done: a test with two replicas and a real PostgreSQL.
