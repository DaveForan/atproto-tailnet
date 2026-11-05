# ADR-0017: DID resolution and identity verification

**Status:** Implemented
**Date:** 2026-11-04
**Priority:** P0
**Depends On:** ADR-0012 (AT Proto identity passport), ADR-0003 (AT Proto OAuth)

## Context

ADR-0012 defines the AT Proto Identity Passport — VC-JWT credentials for
membership, role attestation, and capability tokens. The credential issuer
and verifier modules exist, but the **identity verification infrastructure**
needed to make them work in production is missing:

- Collective DIDs (`did:web`) are generated but no `/.well-known/did.json`
  is served, so remote parties cannot resolve them
- No `PublicKeyResolver` implementation exists outside test mocks
- DID resolution is limited to handle→DID for invitations (Bluesky API)
- No `did:plc` directory lookups or `did:web` document fetching
- Credential verification functions exist but are dead code (no route calls them)
- Holder binding challenge has no submit/verify endpoint

Without DID resolution, the credential system cannot verify that a credential
was issued by a known collective or that a holder is who they claim to be.

## Decision

### 1. Serve a DID document per collective

Collectives share the instance's domain, so their DIDs are path-based:
`did:web:<host>:collective:<slug>` (the port, if any, percent-encoded as
did:web requires — `localhost%3A3000`). did:web maps that to
`https://<host>/collective/<slug>/did.json`, which the service serves.
`/.well-known/did.json?collective=<slug>` is kept as a convenience alias.
The document contains:

```json
{
  "@context": ["https://www.w3.org/ns/did/v1"],
  "id": "did:web:example.com",
  "verificationMethod": [{
    "id": "did:web:example.com#signing-key",
    "type": "JsonWebKey2020",
    "controller": "did:web:example.com",
    "publicKeyJwk": { ... }
  }],
  "authentication": ["did:web:example.com#signing-key"],
  "assertionMethod": ["did:web:example.com#signing-key"]
}
```


### 2. DID resolver module

Create `src/identity/resolver.ts` with a `DIDResolver` that supports:

- **`did:web`**: Fetch `/.well-known/did.json` (or path-based equivalent)
  from the DID's domain, extract the public key from the verification method
- **`did:plc`**: Query the PLC directory (`https://plc.directory/{did}`) to
  resolve the DID document and extract the signing key
- **Local collectives**: DIDs hosted by this instance are answered from
  `collective_dids` directly — no HTTP round-trip to ourselves, and key
  rotation takes effect immediately (never cached)
- **Cache**: bounded cache with TTL (5 min default) to avoid repeated fetches
- **Timeout**: 5s per resolution attempt, fail closed
- **SSRF guard**: DIDs arrive from unauthenticated callers (credential
  verification, HELLO). did:web hosts must use the default HTTPS port and
  resolve only to public addresses; redirects are refused; the fetched
  document's `id` must equal the DID asked for
- **Keys**: Ed25519 `publicKeyJwk` only

This module implements the `PublicKeyResolver` interface expected by
`src/credentials/verifier.ts`.

### 3. Credential verification endpoint

Add `POST /api/credentials/verify` that accepts a signed credential (VC-JWT)
and returns the verification result. Uses the DID resolver to fetch the
issuer's public key, then calls `verifyCredential()`.

The result also reports `revoked: true` when the issuer hosted here has
revoked the credential.

### 4. Holder binding verification endpoint

Add `POST /api/tenants/:tenantId/credentials/challenge/verify` that accepts a
`HolderBindingProof` (nonce + signature + did). The server:
- Atomically claims the challenge by nonce (stored in DB with TTL) — it is
  single-use whether or not verification succeeds
- Verifies the signature against the holder's resolved public key
- Returns the verification result

### 5. Credential status with revocation

Replace the stub status endpoint with a real revocation store:
- `credential_revocations` table tracks revoked credential IDs with reason and timestamp
- `POST /api/tenants/:tenantId/credentials/:credentialId/revoke` to revoke.
  Gated by issuer identity: the caller presents the credential (`jwt`), and
  it is revoked only if it verifies against *this* collective's key and its
  `jti` is the id in the URL — a tenant cannot revoke another issuer's
  credential. Audit-logged as `credential_revoked`
- `GET /.well-known/collective-credential-status/:credentialId` checks the revocation table

## Consequences

- Remote collectives can resolve any collective's DID to its public key
- Credentials can be verified end-to-end without pre-shared keys
- The DID resolver is reusable for both federation handshake signature
  verification and credential verification
- `did:web` resolution depends on DNS and HTTPS — operational concern
  for air-gapped or private deployments (future: `did:plc` as fallback)
- Challenge storage adds a table but challenges are short-lived (5 min TTL)

## Known limitations

- **did:plc holders cannot be verified.** AT Proto account DID documents
  publish secp256k1/P-256 keys as `publicKeyMultibase`, which the resolver
  does not read — and that signing key is held by the user's PDS, so a holder
  could not sign a challenge with it anyway. Holder binding therefore works
  for did:web holders (collectives) only; binding a Bluesky user to a
  credential needs a different proof (e.g. an OAuth-authenticated session).
- Credentials are not recorded at issuance, so revoking one requires the
  credential itself.

