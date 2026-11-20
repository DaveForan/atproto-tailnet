# ADR-0030: Named tailnet services

**Status:** In Progress
**Date:** 2026-11-19
**Priority:** P1
**Depends On:** ADR-0026 (tailnet addresses), ADR-0028 (coordinator DNS), ADR-0029 (gateway node)
**Related:** ADR-0005 §5.8 (service devices and services), §5.9 (board)

## Context

Members run web applications on their devices (for example `local-pilot` and
`food-app`). Today other members must use `http://100.64.x.y:port`. There is no
HTTPS and no readable name. The service registry and the board exist, but the
URL of a service is free text that the member types.

Members want readable HTTPS addresses that they can post to the board, for
example `https://food-app.<BASE_DOMAIN>`. The service must be easy to publish
from a connected device.

## Decision

ADR-0036 defines where services are listed: the public board of the tailnet
and the private board of each member. This ADR defines the names and the HTTPS
path. A private-board name resolves only on the devices of its owner and is
unique for that owner. A public-board name is unique in the tailnet.

### Model

A **named service** has:

- A name: one DNS label in the namespace that tailnet addresses use
  (ADR-0026). First come, first served. The same rules apply: reserved names,
  30-day quarantine after retirement, per-member limit.
- A target: one device of the publisher and one TCP port.
- A tailnet: the tailnet of the device.
- A visibility: `private` (default) or `public` (ADR-0031).

The URL is `https://<name>.<BASE_DOMAIN>`.

### Private path (default)

1. The coordinator sends each device of the tailnet an extra DNS record:
   `<name>.<BASE_DOMAIN>` → tailnet address of the gateway (ADR-0028).
2. The member opens the URL. The gateway accepts the connection on its tailnet
   address.
3. The gateway terminates TLS with the wildcard certificate for
   `*.<BASE_DOMAIN>`. Devices need no certificate. Service names do not appear
   in certificate transparency logs.
4. The gateway selects the service from the TLS server name and proxies to
   `device:port` over the tailnet.
5. The gateway adds identity headers: `X-Tailnet-User` (handle) and
   `X-Tailnet-Device`. It removes such headers from the incoming request first.

From the public internet, `<name>.<BASE_DOMAIN>` resolves to the droplet through
the public wildcard record. The droplet answers the same as for an unknown name.
The response does not show that the service exists.

### Publishing

- Dashboard: Services → Publish → device, port, name, visibility, "Post to
  board".
- MCP tool: for example "publish food-app on port 3000 from my laptop".
- Only the owner of the device can publish on it. The existing
  `requireServiceApproval` setting applies.
- The target application must listen on the tailnet address of the device. An
  application that listens only on `localhost` can be exposed with one command
  on the device. The dashboard shows the command.

### Access control

- With the default tailnet policy (allow all), every member can open every
  service.
- When a tailnet sets an ACL policy, the service adds a rule that allows the
  gateway to reach the registered `device:port` targets only.
- A service can be restricted to roles of the tailnet. The gateway enforces
  this with the caller identity.

### Hierarchy

A parent collective can see services of child collectives. The
`federation_posture` of the child controls this (Closed blocks; Selective and
Open allow), the same as for routes.

## Consequences

- Readable HTTPS URLs for services, inside the tailnet only.
- Traffic between the visitor and the service goes through the gateway. The
  gateway is in the same region as the coordinator.
- The board posts link to stable URLs.

## Acceptance

- A member publishes `food-app` on port 3000 of the Mac. A second device opens
  `https://food-app.<BASE_DOMAIN>` with a valid certificate.
- A device outside the tailnet gets the same response as for an unknown name.
- The application receives `X-Tailnet-User`. A client cannot forge it.
- A name that is a live tailnet address or service is refused.

## Implementation notes

Built:

- **Model.** A service post (ADR-0036) has a `web` flag. A web service needs a
  name and TCP. The TS service sends it to the coordinator as a DNS record
  with a port. No new table and no new API: names, visibility and the
  30-day rules are those of service posts and tailnet addresses.
- **Private path.** For a device that may see the service, the name resolves
  to the gateway. The gateway ends TLS with the wildcard certificate of
  `BASE_DOMAIN`, selects the service by the TLS server name, and proxies to
  the device and port. A request for another name on the same connection gets
  421.
- **Identity.** `X-Tailnet-User` (sign-in name) and `X-Tailnet-Device`. Every
  `x-tailnet-*` header of the caller is removed first. Also
  `X-Forwarded-For`, `-Proto` and `-Host`.
- **Access.** Who may open a service is who gets its DNS record: the devices
  of the author, and for an approved public service the connected devices.
  The gateway checks this for each request. A service that the caller may
  not see answers exactly like a name that does not exist. In member mode the
  coordinator opens two paths only: these devices to ports 80 and 443 of the
  gateway, and the gateway to the published port of the device.
- **Certificate.** Caddy obtains the wildcard certificate (DNS-01). The
  `gateway-certs` service of the compose file copies it to a volume that the
  coordinator reads, and the coordinator loads it again every 6 hours.
- WebSocket and other upgraded connections work. Plain HTTP on port 80
  redirects to HTTPS.
- The dashboard offers "This is a web application" only when the coordinator
  says in `/health` that it runs the gateway.

Differences from the decision:

- The publish flow is the service form of the Boards tab, not a separate
  Services screen. There is no MCP tool yet.
- No restriction of a service to roles. Visibility is by board and
  connection, as for all service posts.
- In a tailnet with an ACL policy (open mode with rules), no rule is added
  for the gateway. The originator must allow it in the policy.
- The hierarchy rule (a parent sees the services of children) is not built.

Not yet done: the acceptance test with a real device and a browser.
