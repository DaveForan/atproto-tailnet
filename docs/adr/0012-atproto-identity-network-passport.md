# ADR-0012: AT Proto identity as network passport

**Status:** Implemented
**Date:** 2026-11-02
**Priority:** P0
**Depends On:** ADR-0003 (auth strategy), ADR-0009 (hierarchical tenancy), ADR-0010 (collective DIDs)

## Context

Identity is currently session-based and tenant-scoped. A user authenticates
via AT Proto OAuth (ADR-0003), gets an HTTP-only session cookie, and
operates within one tenant. The session has no meaning outside that tenant.

The hierarchical tenancy model (ADR-0009) introduces an "internet of
internets" — collectives containing collectives, with users moving between
them. A user in collective A who needs to access federated collective B
faces a problem: B has no session for them and no way to verify who they
are without a round-trip to A's authorization server. Re-authentication at
every boundary is unacceptable at scale (three levels deep = three OAuth
flows), and leaks topology — B learns the user came from A, and A's auth
server learns which collectives its members visit.

We need a portable, self-sovereign identity credential that proves who the
user is, where they belong, and what they can do — verifiable offline and
with selective disclosure. AT Protocol DIDs are the natural foundation:
already the user's stable identity (ADR-0003 stores the DID as primary
key), cryptographically verifiable, and surviving handle changes and PDS
migrations.

## Decision

### DID as universal identity anchor

Every user has exactly one AT Proto DID — their identity across all
collectives. No per-collective accounts, no federated identity mapping
tables. The DID document (resolved via `did:plc` or `did:web`) contains
the user's public signing key, the root of trust for all credentials.

### Credential bundle

A **credential bundle** is a portable, signed package that travels with
the user across collective boundaries:

- **Identity**: DID + public key
- **Memberships**: Which collectives you belong to, each signed by that
  collective's DID (includes collective DID, user DID, timestamp, expiry)
- **Role attestations**: Permission set per collective (from ADR-0005,
  e.g. `manage_devices`, `invite`), signed by that collective — does not
  expose internal role names
- **Reputation tokens** (optional): Trust scores from collectives you've
  participated in, signed by the issuing collective
- **Capability tokens**: Short-lived (4-8 hours), scoped permissions for
  specific traversals — the workhorse for day-to-day boundary crossing

Each element is independently signed and independently presentable. The
user assembles a subset of credentials for each traversal.

Credentials use the **W3C Verifiable Credentials (VC) data model** with
**JWT encoding** (VC-JWT). JWT gives compact wire format, broad library
support, and interop with the wider decentralized identity ecosystem.
Each credential is a signed JWT where the issuer is the collective's DID
and the subject is the user's DID.

### Credential custody modes

Credential bundles "travel with the user" but the custody model differs
by client type, preserving ADR-0003's BFF guarantee that browser sessions
never hold token material:

- **Browser / web sessions**: The BFF model continues unchanged. The
  platform server holds credential material on the user's behalf and
  presents it server-to-server when the user traverses collective
  boundaries. The browser sees only its HTTP-only session cookie — no
  signing keys, no credential JWTs. From the user's perspective this is
  seamless SSO.
- **Tailscale client / agent**: The Tailscale client (or a companion
  daemon) holds credential material locally, alongside the WireGuard
  private key it already manages. This is a natural extension — the
  device already holds key material for network access; credential
  bundles are additional signed artifacts stored in the same trust
  boundary. The daemon signs presentation proofs (see Holder binding)
  on the user's behalf.

Browser sessions MUST NOT hold credential material directly. Any
operation that requires a credential presentation from a browser context
is proxied through the BFF.

### Verification and SSO flow

Any collective can verify a credential bundle without contacting the
issuing collective: resolve the user's DID document for their public key,
verify the bundle envelope signature, resolve each issuing collective's
DID, verify its signature on each credential, and check expiry/scopes.
DID resolution is cacheable and pre-fetchable for known partners.

The single-sign-on flow:

1. User authenticates once at their home collective (AT Proto OAuth + DID)
2. Home collective issues a membership credential signed with its keypair
3. On traversal, user presents credential bundle to destination collective
4. Destination verifies signatures, evaluates against traversal policy
   (ADR-0011), and issues a short-lived local session token
5. No round-trip to the home collective at any point

### Holder binding

A credential bundle alone is not sufficient for access — the presenter
must prove they hold the DID's private signing key. Every credential
presentation requires a **proof-of-possession** challenge-response:

1. The verifier generates a cryptographic nonce and sends it to the
   presenter
2. The presenter signs the nonce with their DID's Ed25519 signing key
3. The verifier checks the signature against the public key in the
   presenter's DID document

This prevents credential replay: a stolen credential bundle is useless
without the corresponding private key. The mechanism is standard
challenge-response, analogous to TLS client certificate authentication.
In the BFF custody mode, the platform server performs the signing on the
user's behalf; in the Tailscale client mode, the local daemon signs.

### Selective disclosure and data portability

Users control which credentials to present at each boundary:

- Public collective: DID only (anonymous presence)
- Federated partner: DID + membership in originating collective
- Restricted service: DID + membership + role attestation + capability

The traversal policy (ADR-0011) declares what it requires; the user
decides whether to meet that bar or walk away.

User data (device configs, preferences, service subscriptions) can be
encrypted for portability. Since the user's DID signing key is Ed25519
(a signing algorithm, not an encryption algorithm), a **separate X25519
encryption key pair** is generated for each user and managed by the
platform alongside their DID. The user's signing key signs a
key-derivation request to authorize creation of the encryption key pair.
Data is encrypted to this X25519 public key and stored as opaque blobs
in any collective. The collective stores data it cannot read; the user
decrypts and applies configuration locally on arrival.

> **Future optimization**: Ed25519 keys can be converted to X25519 keys
> via the birational map defined in RFC 7748, eliminating the need for a
> separate encryption key. This is deferred until library support matures
> and the security implications of key reuse are fully evaluated.

### Revocation

Revocation uses **short-lived credentials + a status endpoint**, avoiding
CRL scaling problems entirely. Membership credentials carry a TTL
(default 24 hours) and must be refreshed from the issuing collective.
Capability tokens are shorter-lived (4-8 hours). For early revocation
before TTL expiry, each issuing collective exposes a status endpoint:

    GET /.well-known/collective-credential-status/:credentialId

This returns `{ "status": "valid" | "revoked", "checked": "<ISO8601>" }`.
Verifiers check this endpoint on credential presentation and cache the
result for 5 minutes. A revoked credential is rejected immediately
regardless of its `exp` timestamp. If the status endpoint is unreachable,
verifiers reject credentials whose TTL exceeds a staleness threshold
(configurable, default 1 hour) and accept only credentials issued within
the threshold window.

### Credential storage

Credentials are stored in two locations by default:

1. **Locally on the user's devices** (encrypted at rest), managed by the
   Tailscale client daemon or the platform's BFF server depending on
   custody mode
2. **On the platform server**, enabling re-issuance and server-side
   presentation for browser sessions

PDS storage is an **explicit opt-in** for users who want cross-platform
credential portability. A new lexicon
(`com.atproto.tailnet.credentials`) would enable interop: other AT Proto
apps could verify network memberships, Bluesky profiles could display
collective affiliations, and credentials survive collective downtime.

> **Privacy warning**: Storing membership credentials in a PDS leaks
> organizational topology. Anyone who can read the user's PDS records
> learns which collectives they belong to and how those collectives
> relate. Users must understand this tradeoff before enabling PDS
> storage. The opt-in flow must present this warning explicitly.

### Key rotation

When a user rotates AT Proto signing keys, credentials signed by the old
key become unverifiable. Rather than polling DID documents for changes,
collectives use **lazy verification**: credentials are verified at
presentation time against the current DID document (cached with a
configurable TTL, default 1 hour). If the DID document shows a rotated
key that does not match the credential's signing key, the credential is
rejected and the user must re-authenticate at their home collective to
get new credentials issued against the new key.

This on-demand approach avoids the need for collectives to poll DID
documents or maintain watchers. Short-lived capability tokens (4-8 hours)
naturally expire before most rotation-related issues surface. No grace
period is needed — the re-authentication flow handles the transition
cleanly.

## Consequences

- **New module**: A credential issuance and verification library — VC-JWT
  signing, bundling, selective assembly, signature checking, holder
  binding challenge-response, and status endpoint integration. This is
  the most significant new component.
- **Cryptographic overhead at boundaries**: Each traversal requires
  multiple signature verifications (user signature + one per credential
  presented). Mitigated by caching verified bundles and issuing local
  session tokens after first verification.
- **Privacy-preserving by default**: Selective disclosure means collectives
  learn only what users volunteer. No central identity broker sees all
  traversals.
- **Offline-capable**: Verification needs only cached DID documents and
  cached credential status responses. Federated collectives in air-gapped
  or intermittently connected environments can still verify credentials
  within the staleness threshold.
- **Interop surface**: The optional PDS lexicon for credentials creates
  an integration point for the broader AT Proto ecosystem, but also a
  new schema to maintain and version. Users who opt in to PDS storage
  accept a topology-leakage tradeoff.
- **Key rotation complexity**: Lazy verification means users must
  re-authenticate after key rotation, which is a UX interruption but
  avoids the operational load of bulk re-issuance and eliminates the
  security risk of grace windows.
- **No per-collective accounts**: Simplifies the data model (no identity
  mapping) but means a user who loses access to their AT Proto DID loses
  access to all collectives simultaneously.
- **Revocation latency**: Status endpoint caching (5 minutes) means a
  revoked credential may be accepted briefly after revocation. The
  short credential TTL (24 hours) and capability token lifetime (4-8
  hours) bound the maximum exposure window even if the status endpoint
  is unreachable.
