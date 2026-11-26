# ADR-0031: Public service exposure

**Status:** Declined (an idea we looked at and chose not to build; 2026-11-23)
**Date:** 2026-11-19
**Priority:** P2
**Depends On:** ADR-0030 (named tailnet services)

## Context

Some services must be reachable from the public internet, for example to share
with a person who is not a member. Tailscale Funnel gives a model:

- Funnel is off until an administrator grants a `funnel` node attribute.
- Funnel uses only ports 443, 8443 and 10000.
- Funnel names are under `ts.net`, which is on the Public Suffix List.

Public exposure has these risks:

1. **Abuse and reputation.** A member who can publish publicly can host any
   content under the domain of the instance. One phishing page can cause
   browser blocklists to flag the whole domain. This also affects the
   dashboard and the sign-in.
2. **Cookie attacks.** Content on a subdomain can set cookies for the parent
   domain ("cookie tossing").
3. **Bandwidth.** Public traffic uses the transfer allowance of the droplet.
4. **Exposure of devices.** A public service is a public entry point into a
   device of a member.

## Decision

### Separate domain

Public services use a separate registrable domain (`PUBLIC_SERVICE_DOMAIN`, for
example `mesotechnics.app`). The dashboard domain never serves member content.
Later, the operator can submit the domain to the Public Suffix List.

### Two approvals

1. The instance operator enables public services for a tailnet.
2. The originator, or a holder of `approve_services`, approves each change of a
   service to `public`.

The audit log records who made a service public and when. The operator and the
originator have an immediate kill switch.

### Access modes

- `public`: anybody can open the service.
- `public-signed-in`: the visitor must sign in with Bluesky. The service can
  limit access to members of the instance or to a list of DIDs.

### Path

Caddy serves the public name on the public interface. Caddy forwards to the
gateway (ADR-0029), which proxies to `device:port`. Tailnet members continue to
use the private path.

### Limits

- Per-service request rate limits and body size limits.
- Per-service and per-tailnet bandwidth counters, with a cap.
- Logs of public access, kept for a limited time.

### Cookie hardening (do in all cases)

The dashboard session cookie changes to a `__Host-` cookie. A subdomain cannot
set or replace it.

## Consequences

- Members can share selected services outside the tailnet.
- The instance domain keeps its reputation if a public service is abused.
- One more domain to register and to configure (DNS and certificate).

## Open question

- Register `PUBLIC_SERVICE_DOMAIN` now, or start with public services disabled
  until a domain is available.

## Acceptance

- A service with visibility `private` is not reachable from the internet.
- A public service needs both approvals before it becomes reachable.
- The kill switch stops public access in less than one minute.
- The dashboard cookie has the `__Host-` prefix.

## Status: declined (2026-11-23)

We do not build public exposure. The idea stays here as a record. No code for
it exists, and no service is reachable from the internet through the gateway.

### Why

- The instance is a private network coordinator. Public exposure also makes it
  a web host for the content of members, with the abuse reports that follow.
- The gateway accepts connections only from devices in a tailnet. Public
  exposure makes it parse traffic from anybody, in the process that also runs
  the relay for every tailnet.
- A service on a member's device is seldom hardened for the internet. A fault
  in it gives an attacker a device that is inside the tailnet.
- Friend shares (ADR-0036) already let a member open one port of one device to
  a chosen person. The other person joins with a device of their own.

### What stays

- The `__Host-` dashboard session cookie ("Cookie hardening") is in production.
  It is correct without public services.
- `Caddyfile.coordinator.production` answers every `*.<SERVICE_DOMAIN>` name
  from the internet with 404. Keep that.

### If the question comes back

Start with `public-signed-in` only: a visitor who signs in with Bluesky has an
identity that can be limited and blocked. Run the public listener as its own
process, apart from the relay and the tailnet gateway. Only the owner of a
device can make its service public (ADR-0036); the operator and the approver
can refuse or revoke, never start it. Write a new ADR for that work.
