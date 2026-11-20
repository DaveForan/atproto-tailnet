# ADR-0026: Tailnet addresses, opaque internal IDs, and a shared control URL

**Status:** In Progress
**Date:** 2026-11-19
**Priority:** P0
**Depends On:** ADR-0023 (Rust mesh coordinator), ADR-0025 (instance operators)

## Context

Each tailnet has a slug. The service derived the slug from the handle of the
originator (`daveforan.bsky.social` → `daveforan-bsky-social`). The slug was
used in these places:

- The control URL of the tailnet: `https://<slug>.<BASE_DOMAIN>`
- The coordinator tenant slug and the `X-Tenant-Slug` header that Caddy sets
- The collective DID: `did:web:<host>:collective:<slug>`
- Public links: `/join/<slug>` and `/board/<slug>`
- Public responses: `GET /api/instance` and `GET /api/tenants/by-slug/:slug/public`

This design has these problems:

1. **Membership leak.** Anybody can find out if a Bluesky user has a tailnet on
   the instance. They request `https://<their-handle>.<BASE_DOMAIN>/key`.
   Caddy answers 200 for a real tailnet and 404 for others.
2. **Identity leak.** The control URL, the public links and the public API
   responses show the handle of the originator.
3. **Stale names.** When a user changes the handle, the slug does not change.
4. **No function in coordinator mode.** The coordinator does not read
   `X-Tenant-Slug`. `/key` returns one instance-wide key. The pre-auth key
   alone selects the tailnet at registration. The per-tailnet hostname is a
   legacy of Headscale mode, where each tailnet was a separate container.

A slug based on the DID is not better. A `did:plc` maps back to the Bluesky
account through the public PLC directory.

## Decision

### 1. Opaque internal IDs

`tenants.slug` stays the permanent internal ID. For new tailnets the service
generates `t-` followed by 10 random characters from an unambiguous alphabet
(about 50 bits). The service never derives the ID from a handle or a DID.

The internal ID is used only by the coordinator, Headscale container names, and
collective DIDs. The service never routes it publicly and never returns it in a
public response.

Existing tailnets keep their internal ID. The internal ID is not visible after
the public alias with the same name is retired (see below).

### 2. Public tailnet addresses

A new table, `tenant_hostnames`, holds the public names of a tailnet:

- Exactly one live **primary** name. Public links and new devices use it.
- Zero or more live **aliases**. They keep old links and enrolled devices
  working after a rename.
- **Retired** names. They do not route. They stay reserved for 30 days. After
  that, anybody can claim them.

Rules:

- One DNS label: lowercase letters, digits and single hyphens, 1-63
  characters, no hyphen at the start or the end.
- Reserved names are refused (`www`, `api`, `admin`, `derp`, `control`, and
  others).
- A name is not available if it is a live name of another tailnet, the internal
  ID of another tailnet, or a name that another tailnet retired less than 30
  days ago.
- A tailnet has a maximum of 5 live names.
- Only the originator can change the names. Agent tokens cannot.

New tailnets get a random friendly name (for example `quiet-harbor-4821`). The
setup wizard asks the originator to choose a name. The Status tab has a
"Tailnet address" card.

Public links (`/join/:name`, `/board/:name`) and the TLS check resolve live
public names only. They never resolve the internal ID.

### 3. Shared control URL

All tailnets use one control URL: `https://control.<APEX_DOMAIN>`. This is the
same model as Tailscale, where all tailnets use one control server. The
pre-auth key selects the tailnet. The Tailscale apps keep profiles apart by
account, so one control URL for many tailnets works.

- The Connect tab, the setup wizard and all key responses show the shared URL.
- Caddy continues to route the hostnames of devices that enrolled under a
  per-tailnet URL. These are legacy hostnames. They route until no device
  uses them. Then the originator retires them.
- The control URL is **not** under `<BASE_DOMAIN>` (`ts.<APEX_DOMAIN>`).
  ADR-0028 explains why: the coordinator sends split DNS for `BASE_DOMAIN`, and
  a control URL under that suffix could stop resolving inside the tailnet.

The public tailnet name is still useful. It is the name in public links, and it
is the namespace for device names (ADR-0028) and services (ADR-0030).

## Consequences

- No public request reveals whether a given Bluesky user has a tailnet.
- One extra DNS record and one Caddy site (`control.<APEX_DOMAIN>`).
- Per-tailnet wildcard routing on `BASE_DOMAIN` is needed only for legacy
  hostnames. ADR-0030 reuses the wildcard for services.
- Migration: the existing tailnet keeps `daveforan-bsky-social` as internal ID
  and as a legacy alias. The originator sets a public name, moves enrolled
  devices to the shared URL, then retires the alias.

## Implementation notes

The address part (sections 1 and 2) is built and not yet committed:
`src/orchestrator/hostnames.ts`, `src/routes/hostnames.ts`, migration
`drizzle/0030_tenant_hostnames.sql`, the wizard step and the Status card. The
shared control URL (section 3) is not built. The migration was not yet run on a
real PostgreSQL database.

## Acceptance

- A request for `<handle>.<BASE_DOMAIN>/key` gives the same answer for every
  handle, after legacy aliases are retired.
- `GET /api/instance` and the public tailnet lookup return no internal ID.
- A new device enrolls with the shared control URL and joins the correct
  tailnet.
- A device that enrolled under a legacy hostname continues to work until the
  alias is retired.
