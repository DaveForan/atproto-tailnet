# ADR-0021: Holder binding for AT Proto accounts

**Status:** Proposed
**Date:** 2026-11-04
**Priority:** P1
**Depends On:** ADR-0003 (AT Proto OAuth), ADR-0012 (identity passport), ADR-0017 (DID resolution)

## Context

ADR-0012 makes a credential useless without proof that the presenter
controls the DID it was issued to ("holder binding"): the verifier sends a
nonce, the presenter signs it "with their DID's Ed25519 signing key", and
the verifier checks the signature against the key in the presenter's DID
document. ADR-0017 built the endpoints for this.

An investigation shows the mechanism cannot work for the people the system
is for — Bluesky / AT Proto account holders:

1. **The key is not Ed25519 and not in the format we read.** A real account
   document (`did:plc:z72i7hdynmk6r22z27h6tvur`, fetched from
   plc.directory) has a single verification method, `#atproto`, of type
   `Multikey` with `publicKeyMultibase: "zQ3sh…"` — a secp256k1 key (P-256
   is the other permitted curve). Our resolver only reads Ed25519
   `publicKeyJwk`, so it returns no key for every real `did:plc`. The
   existing did:plc test passes only because its mock document contains an
   Ed25519 JWK that no real account has.
2. **Nobody we can ask holds that key.** The `#atproto` key is the
   account's repo signing key and lives on the user's PDS. The user never
   has it; neither does our server. ADR-0012's two custody modes ("the
   platform signs on the user's behalf", "the local daemon signs") both
   assume access to a key that neither party has.
3. **`jose` 6 cannot verify it anyway** — it has no ES256K (secp256k1)
   support. Node's `crypto` can (checked: sign/verify round-trip with
   `dsaEncoding: "ieee-p1363"`).

So today holder binding works only when the holder is a `did:web`
collective, which is not a holder ADR-0012 cares about. Separately,
`verifyBundle()` is not called by any route: no endpoint yet accepts a
credential presentation, so nothing currently depends on the broken path.

AT Protocol already has the primitive we need. **Inter-service
authentication** lets an account's PDS mint a short-lived JWT, signed with
the account's `#atproto` key, addressed to a specific service:

- header `alg`: `ES256K` or `ES256`; claims `iss` (account DID), `aud`
  (recipient service DID), `exp`, `iat`, `jti` (anti-replay nonce), and
  optionally `lxm` (the method the token is good for)
- a receiver validates the signature against the `#atproto` key in the
  issuer's DID document, checks `aud` is itself, checks `exp`, and uses
  `jti` to reject reuse
- a client obtains one with `com.atproto.server.getServiceAuth(aud, lxm,
  exp)`; under OAuth this is governed by the `rpc` permission
  (`rpc:<lxm>?aud=<did>`)

Our server already holds each logged-in user's OAuth session (scope
`atproto transition:generic`, DB-backed), so it can make that call on the
user's behalf — which is what ADR-0012's "BFF custody mode" needs.

## Decision

### 1. Two kinds of holder proof

A presentation carries one of:

| Proof | Who can produce it | What it proves |
|-------|--------------------|----------------|
| **AT Proto service-auth token** | Any AT Proto account, via its PDS | The account's PDS — the authority for that DID — vouches that this request is on the account's behalf, to this verifier, now |
| **Key-bound proof** | A device, agent or collective holding its own Ed25519 key | Possession of the specific key the credential was bound to |

The existing nonce challenge (ADR-0017 §4) remains, as the key-bound proof.

### 2. Service-auth proof for accounts

The presenter obtains a service-auth JWT with:

- `iss` — the account DID (must equal the `sub` of every presented
  credential)
- `aud` — the verifying collective's DID with a service fragment
  (`<collective-did>#tailnet_collective`)
- `lxm` — `app.tailnet.credential.present`, so the token is useless for
  anything else, including any real XRPC method
- `exp` — at most 60 seconds out

The verifier:

1. Resolves `iss` and selects the `#atproto` verification method only
2. Verifies the ES256K / ES256 signature, rejecting high-S signatures as
   the AT Proto cryptography spec requires
3. Requires `aud` to be exactly its own DID + fragment, `lxm` to be the
   presentation method, and `exp` to be in the future and no more than a
   short maximum away
4. Records `jti` until `exp` and rejects a repeat

There is no verifier-issued nonce in this flow — the caller cannot choose
the token's `jti`. Replay protection comes from the audience binding (the
token is only good at this verifier), the short lifetime, and the `jti`
cache. This also removes a round trip.

Custody, replacing ADR-0012's assumption that someone signs with the
user's key:

- **Browser / web sessions (BFF):** the platform server calls
  `getServiceAuth` through the user's stored OAuth session and presents the
  resulting token server-to-server. The browser still holds nothing.
- **Same-instance traversal:** when presenter and verifier are the same
  instance and the user has a live session, the session *is* the proof; no
  token is minted.

### 3. Key-bound credentials for devices and agents

A Tailscale client, daemon or agent has no PDS to ask. For these, the
credential itself names the key that may present it: at issuance the
device supplies an Ed25519 public key, and the collective includes it as a
confirmation claim (`cnf.jwk`, RFC 7800). The presenter then signs the
verifier's nonce with that key — the existing challenge endpoints, with
the key taken from the credential instead of from a DID document.

Issuing a key-bound credential requires an authenticated session or agent
token for the subject, so a device key is only ever bound by the account
it belongs to.

### 4. Resolver returns typed keys

`PublicKeyResolver.resolve(did)` currently returns a bare key assumed to
be EdDSA. It will return the key together with its algorithm and the
verification-method id, and gain multikey decoding (`publicKeyMultibase`,
base58btc, secp256k1 and P-256 multicodec prefixes). Callers state which
method and algorithms they accept:

- collective signatures (credentials, CFP messages): `#signing-key`, EdDSA
- account service-auth tokens: `#atproto`, ES256K / ES256

Add `@atproto/crypto` for multikey parsing and low-S signature
verification rather than hand-rolling either.

### 5. OAuth scope

Keep `transition:generic` for now and add the granular permission
`rpc:app.tailnet.credential.present?aud=*` to the client metadata, so the
consent screen says what the app will do with it and the app keeps working
when transitional scopes are retired. Existing sessions lack the new
scope; users are asked to re-authorize the first time a proof is needed.

### 6. Correct ADR-0012

ADR-0012's "Holder binding" section and its statement that the user's DID
document contains "the user's public signing key, the root of trust for all
credentials" are superseded by this ADR for AT Proto accounts.

## Consequences

- Holder binding works for the actual user base, using the mechanism AT
  Protocol services already use to authenticate accounts to each other.
- The PDS becomes part of the trust path for presentations: a compromised
  or malicious PDS can present its users' credentials. That is already
  true of everything else about an AT Proto identity, and credentials stay
  short-lived (4–24 hours).
- Presentation by a browser user needs the user's PDS to be reachable at
  that moment; key-bound device credentials do not.
- The verifier keeps short-lived state (the `jti` cache). It can live in
  the database alongside `holder_binding_challenges`.
- The resolver interface changes, touching the credential verifier and the
  CFP message verifier.
- A new dependency (`@atproto/crypto`).

## To verify before implementing

These come from the AT Proto specifications, not from a test against a
live PDS:

- that `getServiceAuth` succeeds through an OAuth session holding only
  `transition:generic`, for a custom `lxm` and a `did:web` audience the PDS
  has never seen;
- whether the PDS requires the audience DID to be resolvable or to declare
  the named service fragment in its DID document (if so, collective DID
  documents gain a `service` entry);
- the maximum `exp` a PDS will grant for a custom `lxm`.

A short spike with a real account against the local instance answers all
three.

## Not in scope

- Where presentations are consumed. No route accepts a credential bundle
  yet; wiring presentation into traversal (ADR-0011) is separate work.
- Selective disclosure and reputation tokens (ADR-0012).
