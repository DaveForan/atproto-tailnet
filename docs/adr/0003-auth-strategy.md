# ADR-0003: AT Protocol OAuth for user authentication

**Status:** Accepted
**Date:** 2026-10-23

## Context

We need an identity system where users create and manage tailnets, and invite others. The project's core premise is using AT Protocol (Bluesky) identities — no email/password, no GitHub OAuth, no separate account system.

### AT Protocol identity model

- **DID** (Decentralized Identifier): The stable, permanent identity. Format: `did:plc:abc123...` or `did:web:example.com`. Survives handle changes and PDS migrations.
- **Handle**: The human-friendly name (`@alice.bsky.social`, `@alice.example.com`). Mutable — users can change handles. Resolved to DID via DNS TXT or HTTP.
- **PDS** (Personal Data Server): Where the user's data lives. Discovered from the DID document's `#atproto_pds` service endpoint.

### AT Proto OAuth 2.0 status

Production-ready. Official TypeScript SDK (`@atproto/oauth-client-node`) handles:

- **DPoP** (RFC 9449) — proof-of-possession tokens, mandatory in AT Proto (first large platform to require it)
- **PKCE** — mandatory
- **PAR** (Pushed Authorization Requests) — mandatory
- **Federated PDS discovery** — resolves handle → DID → PDS → authorization server automatically
- **Token refresh** — automatic, with `requestLock` to prevent concurrent refresh races

The flow works across any PDS (Bluesky-hosted `bsky.social` or self-hosted instances) without pre-registration at each provider.

### Client metadata

AT Proto uses URL-based client discovery instead of pre-registration:

- `client_id` is a URL pointing to a hosted JSON metadata document
- Authorization servers fetch this document at auth time
- Production: confidential client with `private_key_jwt` (ES256) + JWKS endpoint
- Development: `buildAtprotoLoopbackClientMetadata()` for local testing

## Decision

Use **AT Protocol OAuth 2.0** as the sole authentication mechanism, with the **BFF (Backend For Frontend)** pattern:

1. All tokens stay server-side
2. Browser sessions use HTTP-only cookies tied to OAuth sessions
3. The `@atproto/oauth-client-node` SDK handles the full flow
4. User identity is the **DID** (stable key in our database), with the **handle** stored for display and invitation resolution

### Data model

```
┌──────────────────────────────┐
│ users                        │
├──────────────────────────────┤
│ id           UUID PK         │
│ did          TEXT UNIQUE      │  ← stable identity
│ handle       TEXT             │  ← display, mutable
│ display_name TEXT             │
│ avatar_url   TEXT             │
│ created_at   TIMESTAMP       │
│ updated_at   TIMESTAMP       │
└──────────────────────────────┘
```

### Invitation flow

1. Owner types `@bob.bsky.social` to invite someone
2. Service resolves handle → DID (via AT Proto resolution)
3. Invitation stored against the DID
4. When Bob logs in (via AT Proto OAuth), his DID matches the invitation
5. Bob is added to the tenant's Headscale instance (pre-auth key generated)

## Consequences

- Users must have an AT Protocol identity (Bluesky account or self-hosted PDS) to use the service.
- No email/password fallback — this is intentional; AT Proto identity IS the product differentiator.
- Handle changes are transparent — we identify by DID, display by handle, and refresh the handle periodically.
- Self-hosted PDS users are first-class citizens with no extra configuration.
- We depend on `@atproto/oauth-client-node` (0.x versions), which is pre-1.0 but used in production by Bluesky itself.

## Implementation requirements

- 2 npm packages: `@atproto/oauth-client-node`, `@atproto/api`
- 2 HTTP endpoints: login initiation (`/auth/login`), OAuth callback (`/auth/callback`)
- 2 DB tables: auth state (CSRF/PKCE), auth sessions (DID → tokens)
- Production: hosted client metadata JSON at `/.well-known/atproto-client-metadata.json` + JWKS endpoint
- ES256 key pair for `private_key_jwt` client authentication
