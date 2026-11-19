# ADR-0012: AT Proto identity as network passport

**Status:** Implemented
**Date:** 2026-11-02
**Priority:** P0
**Depends On:** ADR-0003 (auth strategy), ADR-0009 (hierarchical tenancy), ADR-0010 (collective DIDs)

## Context

Identity is currently session-based and limited to one tenant. A user
logs in with AT Proto OAuth (ADR-0003) and receives an HTTP-only session
cookie. The user then operates within one tenant. The session has no
meaning outside that tenant.

The hierarchical tenancy model (ADR-0009) introduces an "internet of
internets". Collectives contain collectives, and users move between them.
Consider a user in collective A who needs access to federated collective B.
B has no session for the user. B cannot verify the user without a round-trip
to the authorization server of A. Re-authentication at every boundary does
not scale. Three levels of depth need three OAuth flows. It also leaks
topology. B learns that the user came from A. The auth server of A learns
which collectives its members visit.

We need a portable, self-sovereign identity credential. It proves who the
user is, where the user belongs, and what the user can do. Verifiers can
check it offline, and it supports selective disclosure. AT Protocol DIDs are
the natural foundation. They are already the stable identity of the user
(ADR-0003 stores the DID as the primary key). They are cryptographically
verifiable. They stay the same when handles change and PDS migrations
happen.

## Decision

### DID as universal identity anchor

Every user has exactly one AT Proto DID. This is the identity of the user
across all collectives. The system has no accounts for each collective and
no federated identity mapping tables. The DID document (resolved through
`did:plc` or `did:web`) contains the public signing key of the user. This
key is the root of trust for all credentials.

### Credential bundle

A **credential bundle** is a portable, signed package. It travels with the
user across collective boundaries. It contains these elements:

- **Identity**: DID and public key
- **Memberships**: The collectives that the user belongs to. The DID of each
  collective signs its membership (it includes the collective DID, user DID,
  timestamp, and expiry).
- **Role attestations**: The permission set for each collective (from
  ADR-0005, for example `manage_devices`, `invite`). The collective signs
  it. It does not expose internal role names.
- **Reputation tokens** (optional): Trust scores from collectives where the
  user participated. The issuing collective signs them.
- **Capability tokens**: Short-lived (4-8 hours) permissions with a defined
  scope for specific traversals. These are the main tool for daily boundary
  crossing.

Each element has its own signature, and the user can present each element
independently. The user assembles a subset of credentials for each
traversal.

Credentials use the **W3C Verifiable Credentials (VC) data model** with
**JWT encoding** (VC-JWT). JWT has a compact wire format and broad library
support. It also interoperates with the wider decentralized identity
ecosystem. Each credential is a signed JWT. The issuer is the DID of the
collective, and the subject is the DID of the user.

### Credential custody modes

Credential bundles "travel with the user", but the custody model depends
on the client type. This preserves the BFF guarantee of ADR-0003: browser
sessions never hold token material.

- **Browser / web sessions**: The BFF model does not change. The
  platform server holds the credential material for the user. It presents
  the material server-to-server when the user crosses collective
  boundaries. The browser sees only its HTTP-only session cookie. It has no
  signing keys and no credential JWTs. The user experiences seamless SSO.
- **Tailscale client / agent**: The Tailscale client (or a companion
  daemon) holds the credential material locally. It stores the material
  next to the WireGuard private key that it already manages. This is a
  natural extension. The device already holds key material for network
  access. Credential bundles are more signed artifacts in the same trust
  boundary. The daemon signs presentation proofs (see Holder binding) for
  the user.

Browser sessions MUST NOT hold credential material directly. The BFF
proxies each operation that needs a credential presentation from a browser
context.

### Verification and SSO flow

Any collective can verify a credential bundle. It does not need to contact
the issuing collective. The verifier does these steps:

1. Resolve the DID document of the user to obtain the public key.
2. Verify the signature on the bundle envelope.
3. Resolve the DID of each issuing collective.
4. Verify the signature of the collective on each credential.
5. Check the expiry and scopes.

DID resolution can be cached. For known partners, the system can pre-fetch
it.

The single-sign-on flow has these steps:

1. The user logs in once at the home collective (AT Proto OAuth and DID).
2. The home collective issues a membership credential. It signs the
   credential with its keypair.
3. On traversal, the user presents the credential bundle to the destination
   collective.
4. The destination verifies the signatures and evaluates the traversal
   policy (ADR-0011). Then it issues a short-lived local session token.
5. At no point does the system make a round-trip to the home collective.

### Holder binding

A credential bundle alone does not give access. The presenter must prove
that they hold the private signing key of the DID. Every credential
presentation needs a **proof-of-possession** challenge-response:

1. The verifier generates a cryptographic nonce and sends it to the
   presenter.
2. The presenter signs the nonce with the Ed25519 signing key of their DID.
3. The verifier checks the signature against the public key in the DID
   document of the presenter.

This prevents credential replay. A stolen credential bundle is useless
without the matching private key. The mechanism is standard
challenge-response, similar to TLS client certificate authentication.
In BFF custody mode, the platform server signs for the user. In
Tailscale client mode, the local daemon signs.

### Selective disclosure and data portability

Users control which credentials they present at each boundary:

- Public collective: DID only (anonymous presence)
- Federated partner: DID and membership in the originating collective
- Restricted service: DID, membership, role attestation, and capability

The traversal policy (ADR-0011) declares what it requires. The user decides
to meet that requirement or to leave.

Users can encrypt their data (device configs, preferences, service
subscriptions) for portability. The signing key of the user's DID is
Ed25519. It is a signing algorithm, not an encryption algorithm. The
platform generates a **separate X25519 encryption key pair** for
each user and manages it with the DID of the user. The signing key of the
user signs a key-derivation request. This authorizes the creation of the
encryption key pair. The system encrypts data to this X25519 public key and
stores it as opaque blobs in any collective. The collective stores data
that it cannot read. The user decrypts the data and applies the
configuration locally on arrival.

> **Future optimization**: The birational map in RFC 7748 can convert
> Ed25519 keys to X25519 keys. This removes the need for a
> separate encryption key. We defer this until library support matures
> and we fully evaluate the security implications of key reuse.

### Revocation

Revocation uses **short-lived credentials and a status endpoint**. This
avoids CRL scaling problems entirely. Membership credentials have a TTL
(default 24 hours). The holder must refresh them from the issuing
collective. Capability tokens have a shorter life (4-8 hours). For early
revocation before the TTL expires, each issuing collective exposes a status
endpoint:

    GET /.well-known/collective-credential-status/:credentialId

This endpoint returns `{ "status": "valid" | "revoked", "checked": "<ISO8601>" }`.
Verifiers check this endpoint when a credential is presented. They cache
the result for 5 minutes. Verifiers reject a revoked credential
immediately, regardless of its `exp` timestamp. If the status endpoint is
unreachable, verifiers reject credentials whose TTL exceeds a staleness
threshold (configurable, default 1 hour). They accept only credentials
issued within the threshold window.

### Credential storage

By default, the system stores credentials in two locations:

1. **Locally on the user's devices** (encrypted at rest). The Tailscale
   client daemon or the BFF server of the platform manages them, depending
   on the custody mode.
2. **On the platform server**. This enables re-issuance and server-side
   presentation for browser sessions.

PDS storage is an **explicit opt-in** for users who want cross-platform
credential portability. A new lexicon
(`com.atproto.tailnet.credentials`) would enable interoperability. Other
AT Proto apps could verify network memberships. Bluesky profiles could show
collective affiliations. Credentials would survive collective downtime.

> **Privacy warning**: Credentials in a PDS leak the organizational
> topology. Anyone who can read the PDS records of the user learns which
> collectives the user belongs to and how those collectives relate. Users
> must understand this tradeoff before they enable PDS storage. The opt-in
> flow must show this warning explicitly.

### Key rotation

When a user rotates AT Proto signing keys, the credentials that the old key
signed become unverifiable. Collectives do not poll DID documents for
changes. They use **lazy verification** instead. The verifier checks a
credential at presentation time against the current DID document (cached
with a configurable TTL, default 1 hour). If the DID document shows a
rotated key that does not match the signing key of the credential, the
verifier rejects the credential. The user must then log in again at the
home collective. The home collective issues new credentials for the new
key.

This on-demand approach means collectives do not need to poll DID
documents or maintain watchers. Short-lived capability tokens (4-8 hours)
expire before most rotation-related issues appear. The system needs no
grace period, because the re-authentication flow handles the transition
cleanly.

## Consequences

- **New module**: A credential issuance and verification library. It
  handles VC-JWT signing, bundling, selective assembly, signature checking,
  holder binding challenge-response, and status endpoint integration. This
  is the most significant new component.
- **Cryptographic overhead at boundaries**: Each traversal needs multiple
  signature verifications (the user signature and one for each credential
  presented). The system reduces this cost. It caches verified bundles and
  issues local session tokens after the first verification.
- **Privacy-preserving by default**: Selective disclosure means that
  collectives learn only what users volunteer. No central identity broker
  sees all traversals.
- **Offline-capable**: Verification needs only cached DID documents and
  cached credential status responses. Federated collectives in air-gapped
  or intermittently connected environments can still verify credentials
  within the staleness threshold.
- **Interop surface**: The optional PDS lexicon for credentials creates
  an integration point for the broader AT Proto ecosystem. It also creates
  a new schema that we must maintain and version. Users who opt in to PDS
  storage accept a topology-leakage tradeoff.
- **Key rotation complexity**: Lazy verification means that users must log
  in again after a key rotation. This interrupts the user. But it avoids the
  operational load of bulk re-issuance, and it removes the security risk of
  grace windows.
- **No accounts for each collective**: This simplifies the data model (no
  identity mapping). But a user who loses access to their AT Proto DID
  loses access to all collectives at the same time.
- **Revocation latency**: Status endpoint caching (5 minutes) means that a
  verifier can accept a revoked credential for a short time after
  revocation. The short credential TTL (24 hours) and the capability token
  lifetime (4-8 hours) limit the maximum exposure window, even if the
  status endpoint is unreachable.
