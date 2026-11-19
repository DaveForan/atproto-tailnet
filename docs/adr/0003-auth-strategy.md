# ADR-0003: AT Protocol OAuth for user authentication

**Status:** Accepted
**Date:** 2026-10-23

## Context

We need an identity system. Users create and manage tailnets, and they invite other users. The core premise of the project is to use AT Protocol (Bluesky) identities. The service has no email/password login, no GitHub OAuth, and no separate account system.

### AT Protocol identity model

- **DID** (Decentralized Identifier): The stable, permanent identity. Format: `did:plc:abc123...` or `did:web:example.com`. It stays the same when the handle or the PDS changes.
- **Handle**: The human-friendly name (`@alice.bsky.social`, `@alice.example.com`). It can change, because users can change handles. DNS TXT or HTTP resolves the handle to a DID.
- **PDS** (Personal Data Server): The server that stores the user's data. The `#atproto_pds` service endpoint in the DID document identifies the PDS.

### AT Proto OAuth 2.0 status

AT Proto OAuth is ready for production. The official TypeScript SDK (`@atproto/oauth-client-node`) handles these items:

- **DPoP** (RFC 9449): proof-of-possession tokens. AT Proto requires them (the first large platform to do so).
- **PKCE**: required.
- **PAR** (Pushed Authorization Requests): required.
- **Federated PDS discovery**: the SDK resolves handle, then DID, then PDS, then authorization server, automatically.
- **Token refresh**: automatic. The `requestLock` option prevents concurrent refresh races.

The flow works with any PDS (Bluesky-hosted `bsky.social` or self-hosted instances). We do not need to register at each provider before use.

### Client metadata

AT Proto uses URL-based client discovery. It does not use pre-registration.

- `client_id` is a URL that points to a hosted JSON metadata document.
- Authorization servers fetch this document at authentication time.
- Production: a confidential client with `private_key_jwt` (ES256) and a JWKS endpoint.
- Development: `buildAtprotoLoopbackClientMetadata()` for local tests.

## Decision

We chose **AT Protocol OAuth 2.0** as the only authentication mechanism. We use the **BFF (Backend For Frontend)** pattern:

1. All tokens stay on the server.
2. Browser sessions use HTTP-only cookies tied to OAuth sessions.
3. The `@atproto/oauth-client-node` SDK handles the full flow.
4. The user identity is the **DID** (the stable key in our database). We store the **handle** for display and for invitation resolution.

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

1. The owner types `@bob.bsky.social` to invite a user.
2. The service resolves the handle to a DID (through AT Proto resolution).
3. The service stores the invitation against the DID.
4. When Bob logs in (through AT Proto OAuth), his DID matches the invitation.
5. The service adds Bob to the Headscale instance of the tenant (and generates a pre-auth key).

## Consequences

- Users must have an AT Protocol identity (a Bluesky account or a self-hosted PDS) to use the service.
- The service has no email/password fallback. This is intentional, because the AT Proto identity is the product differentiator.
- Handle changes are transparent. We identify users by DID, display the handle, and refresh the handle periodically.
- Users with a self-hosted PDS are first-class users. They need no extra configuration.
- We depend on `@atproto/oauth-client-node` (0.x versions). It is pre-1.0, but Bluesky uses it in production.

## Implementation requirements

- 2 npm packages: `@atproto/oauth-client-node`, `@atproto/api`
- 2 HTTP endpoints: login initiation (`/auth/login`), OAuth callback (`/auth/callback`)
- 2 DB tables: auth state (CSRF/PKCE), auth sessions (DID → tokens)
- Production: hosted client metadata JSON at `/.well-known/atproto-client-metadata.json` and a JWKS endpoint
- ES256 key pair for `private_key_jwt` client authentication
