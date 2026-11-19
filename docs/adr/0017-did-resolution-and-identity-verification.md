# ADR-0017: DID resolution and identity verification

**Status:** Implemented
**Date:** 2026-11-04
**Priority:** P0
**Depends On:** ADR-0012 (AT Proto identity passport), ADR-0003 (AT Proto OAuth)

## Context

ADR-0012 defines the AT Proto Identity Passport. It has VC-JWT credentials for
membership, role attestation, and capability tokens. The credential issuer and
verifier modules exist. But the **identity verification infrastructure** that
they need in production is missing:

- The service generates collective DIDs (`did:web`) but serves no
  `/.well-known/did.json`, so remote parties cannot resolve them
- No `PublicKeyResolver` implementation exists outside test mocks
- DID resolution covers only handle→DID for invitations (Bluesky API)
- The service has no `did:plc` directory lookups and no `did:web` document
  fetching
- The credential verification functions are dead code (no route calls them)
- The holder binding challenge has no submit or verify endpoint

Without DID resolution, the credential system cannot verify that a known
collective issued a credential. It also cannot verify that a holder is the
person that the holder claims to be.

## Decision

### 1. Serve a DID document per collective

Collectives share the domain of the instance, so their DIDs are path-based:
`did:web:<host>:collective:<slug>`. The port, if any, is percent-encoded as
did:web requires (`localhost%3A3000`). did:web maps that DID to
`https://<host>/collective/<slug>/did.json`, which the service serves. We keep
`/.well-known/did.json?collective=<slug>` as a convenience alias. The document
contains:

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

We created `src/identity/resolver.ts` with a `DIDResolver` that supports:

- **`did:web`**: Fetch `/.well-known/did.json` (or the path-based equivalent)
  from the domain of the DID. Extract the public key from the verification
  method
- **`did:plc`**: Query the PLC directory (`https://plc.directory/{did}`) to
  resolve the DID document and extract the signing key
- **Local collectives**: The resolver answers DIDs that this instance hosts
  from `collective_dids` directly. It makes no HTTP round-trip to itself. Key
  rotation takes effect immediately because the resolver never caches these
  DIDs
- **Cache**: a bounded cache with TTL (5 min default) prevents repeated
  fetches
- **Timeout**: 5s for each resolution attempt, fail closed
- **SSRF guard**: DIDs arrive from unauthenticated callers (credential
  verification, HELLO). The did:web hosts must use the default HTTPS port and
  must resolve only to public addresses. The resolver refuses redirects. The
  `id` of the fetched document must equal the requested DID
- **Keys**: Ed25519 `publicKeyJwk` only

This module implements the `PublicKeyResolver` interface that
`src/credentials/verifier.ts` expects.

### 3. Credential verification endpoint

We added `POST /api/credentials/verify`. It accepts a signed credential
(VC-JWT) and returns the verification result. It uses the DID resolver to
obtain the public key of the issuer. Then it calls `verifyCredential()`.

The result also reports `revoked: true` when the issuer that this instance
hosts has revoked the credential.

### 4. Holder binding verification endpoint

We added `POST /api/tenants/:tenantId/credentials/challenge/verify`. It
accepts a `HolderBindingProof` (nonce, signature, and did). The server does
these steps:
- It atomically claims the challenge by nonce (stored in the DB with a TTL).
  The challenge is single-use whether or not verification succeeds
- It verifies the signature against the resolved public key of the holder
- It returns the verification result

### 5. Credential status with revocation

We replaced the stub status endpoint with a real revocation store:
- The `credential_revocations` table tracks revoked credential IDs with a
  reason and a timestamp
- `POST /api/tenants/:tenantId/credentials/:credentialId/revoke` revokes a
  credential. Issuer identity gates it. The caller presents the credential
  (`jwt`). The server revokes it only if it verifies against the key of *this*
  collective and its `jti` is the id in the URL. A tenant cannot revoke the
  credential of another issuer. The server audit-logs the action as
  `credential_revoked`
- `GET /.well-known/collective-credential-status/:credentialId` checks the
  revocation table

## Consequences

- Remote collectives can resolve the DID of any collective to its public key
- The system can verify credentials end-to-end without pre-shared keys
- The DID resolver is reusable for both federation handshake signature
  verification and credential verification
- `did:web` resolution depends on DNS and HTTPS. This is an operational concern
  for air-gapped or private deployments (future: `did:plc` as fallback)
- Challenge storage adds a table, but challenges are short-lived (5 min TTL)

## Known limitations

- **did:plc holders cannot be verified.** The DID documents of AT Proto
  accounts publish secp256k1/P-256 keys as `publicKeyMultibase`. The resolver
  does not read this format. The PDS of the user also holds that signing key,
  so a holder could not sign a challenge with it anyway. Holder binding
  therefore works only for did:web holders (collectives). To bind a Bluesky
  user to a credential, we need a different proof (for example, an
  OAuth-authenticated session).
- The system does not record credentials at issuance. To revoke a credential,
  the caller must present the credential itself.
