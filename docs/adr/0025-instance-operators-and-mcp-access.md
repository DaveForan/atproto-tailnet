# ADR-0025: Instance operators and MCP access

**Status:** Accepted
**Date:** 2026-11-19
**Priority:** P0
**Depends On:** ADR-0003 (AT Protocol OAuth), ADR-0005 (tenant security management), ADR-0023 (Rust mesh coordinator)

## Context

The first versions gave a tailnet to each person who signed in. Any Bluesky
account can sign in. On a public instance this has these effects:

- A stranger can create a tailnet and use the resources of the instance.
- The person who runs the instance has no control over who gets a tailnet.
- The person who runs the instance has no tool to stop abuse. There is no way
  to suspend a tailnet or to disable an account.

The instance also needs an administration path that is not tied to one
tailnet. Tenant roles (ADR-0005) apply to one tailnet only.

Users also want to manage their tailnets from Claude. Claude connects to remote
MCP servers through OAuth. The service already has agent tokens (`at_…`). An
agent token applies to one tailnet and the user must copy it by hand. A custom
connector in Claude needs a standard OAuth flow and a discovery document.

## Decision

### 1. Operators come from the environment

The instance operators are the DIDs in the `OPERATOR_DIDS` environment
variable. The list is comma-separated. The service reads it at startup.

- An operator gets a tailnet at sign-in.
- An operator can use the operator API (`/api/operator/*`) and the
  **Instance** tab.
- An operator can designate "tailnet creators". A tailnet creator is a DID that
  can also create one tailnet.
- If `OPERATOR_DIDS` is empty, the service logs a loud warning. Nobody can
  create a tailnet.

Agent tokens never carry operator powers. They apply to one tailnet only.

### 2. The instance is invite-only

Only operators and tailnet creators get a tailnet. The single entry point is
`canCreateTailnet(user)` in `src/operator/policy.ts`. Each creation path calls
it: sign-in, `POST /api/tenants/mine` and the MCP `create_tailnet` tool.

Each other person who signs in gets a "no access" view. The view shows their
pending invitations. It can also show a **Request to join** button for the
default tailnet.

An operator can turn on single-tailnet mode. In this mode the instance has
only one top-level tailnet. The service also refuses new sub-collectives.

### 3. Invitations are the allow-list

An invitation is the allow-list entry for one tailnet. An admin invites a
person by handle or by DID. The response contains an `inviteUrl`
(`/invite/<id>`). The service sends nothing. The admin copies the link and
shares it.

### 4. The default tailnet takes join requests

The first tailnet that an operator creates becomes the default tailnet. The
service turns on join requests for it. A person with no access can ask to join
it. An operator can select a different default tailnet. The service then turns
on join requests for that tailnet.

Join requests have these limits:

- 50 pending requests for each tailnet
- One pending request for each person
- A 24-hour cooldown after a rejection

### 5. Operator controls

The operator API and the **Instance** tab give these controls:

- Overview of tailnets and users
- Instance settings (single-tailnet mode, default tailnet)
- Tailnet creators (add, remove)
- Suspend and unsuspend a tailnet. Suspension cascades to sub-tailnets. The
  coordinator enforces it: devices cannot register or poll the map.
- Delete a tailnet
- Disable and enable a user. Disable removes the devices and keys of the user
  and revokes the MCP connections of the user.
- Activity log

### 6. MCP access through OAuth with Bluesky sign-in

The service is an OAuth authorization server for its own MCP endpoint
(`https://<APP_DOMAIN>/mcp`). It supports these standards:

- Authorization server metadata (RFC 8414)
- Protected resource metadata (RFC 9728)
- Dynamic client registration (RFC 7591)
- PKCE with S256
- Token revocation (RFC 7009)

The user signs in with the existing Bluesky sign-in. The service then shows a
consent page. The page labels the client "Unverified app" and shows the host of
the redirect URI. The client chooses its own name, so the redirect host is the
only reliable fact.

An MCP token acts as the user. It has the same permissions as the user in the
dashboard. It works only through the `/mcp` tools. The REST API refuses an MCP
token from any other caller with 401.

### 7. The operator scope is an opt-in

The consent page shows an extra checkbox to operators only: "Also allow
instance operator actions". The checkbox is clear by default. The service
shows operator tools only when the grant has this scope and the user is still
an operator.

## Alternatives considered

### First user becomes admin

Many self-hosted apps make the first account an admin. We rejected this
approach for these reasons:

- Sign-in is open to every Bluesky account. On a new public instance, a
  stranger can sign in before the owner does. That stranger then owns the
  instance.
- The admin identity is then data in the database. A restore or a reset can
  change it without notice.
- An environment variable is explicit and auditable. It is part of the
  deployment, the same as the other secrets.

### Open sign-up with quotas

Each user gets a tailnet with a small quota. We rejected this because the
operator still pays for strangers, and quotas do not stop abuse.

### Agent tokens for Claude

The user pastes an `at_…` token into Claude. We rejected this because Claude
custom connectors use OAuth. A token also applies to one tailnet only, and the
user must rotate it by hand.

## Consequences

- An operator must set `OPERATOR_DIDS` before the first sign-in. The operator
  must sign in first. The deployment guides say this.
- A change to the operator list needs a restart.
- A person without an invitation sees only the no-access view. This is the
  expected behavior on an invite-only instance.
- The service is now an OAuth authorization server. It stores clients, grants
  and token hashes in `mcp_oauth_clients`, `mcp_oauth_grants` and
  `mcp_oauth_tokens`.
- Access tokens expire after 1 hour. Refresh tokens expire after 30 days and
  rotate on each use.
- A user can see and revoke each connection in **Account → Connect Claude**.
