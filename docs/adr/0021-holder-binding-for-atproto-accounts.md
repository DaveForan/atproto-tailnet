# ADR-0021: Holder binding for AT Proto accounts

**Status:** In Progress
**Date:** 2026-11-04
**Priority:** P1
**Depends On:** ADR-0003 (AT Proto OAuth), ADR-0012 (identity passport), ADR-0017 (DID resolution)

## Context

ADR-0012 makes a credential useless without proof that the presenter controls
the DID that the issuer gave the credential to ("holder binding"). The verifier
sends a nonce. The presenter signs it "with their DID's Ed25519 signing key".
The verifier checks the signature against the key in the DID document of the
presenter. ADR-0017 built the endpoints for this.

An investigation shows that the mechanism cannot work for the people that the
system serves: Bluesky / AT Proto account holders:

1. **The key is not Ed25519 and is not in the format that we read.** A real
   account document (`did:plc:z72i7hdynmk6r22z27h6tvur`, fetched from
   plc.directory) has a single verification method, `#atproto`. Its type is
   `Multikey` with `publicKeyMultibase: "zQ3sh…"`. This is a secp256k1 key
   (P-256 is the other permitted curve). Our resolver reads only Ed25519
   `publicKeyJwk`, so it returns no key for every real `did:plc`. The existing
   did:plc test passes only because its mock document contains an Ed25519 JWK
   that no real account has.
2. **Nobody that we can ask holds that key.** The `#atproto` key is the repo
   signing key of the account. It lives on the PDS of the user. The user never
   has it, and our server does not have it either. ADR-0012 has two custody
   modes ("the platform signs on the user's behalf", "the local daemon signs").
   Both modes assume access to a key that neither party has.
3. **`jose` 6 cannot verify it anyway.** It has no ES256K (secp256k1) support.
   Node `crypto` can verify it (we checked a sign/verify round-trip with
   `dsaEncoding: "ieee-p1363"`).

Today, holder binding works only when the holder is a `did:web` collective.
ADR-0012 does not care about such a holder. Also, no route calls
`verifyBundle()`. No endpoint accepts a credential presentation yet, so nothing
currently depends on the broken path.

AT Protocol already has the primitive that we need. **Inter-service
authentication** lets the PDS of an account mint a short-lived JWT. The PDS
signs it with the `#atproto` key of the account. The JWT is addressed to a
specific service:

- The header `alg` is `ES256K` or `ES256`. The claims are `iss` (account DID),
  `aud` (recipient service DID), `exp`, `iat`, `jti` (anti-replay nonce), and
  optionally `lxm` (the method that the token is good for)
- A receiver validates the signature against the `#atproto` key in the DID
  document of the issuer. It checks that `aud` is itself and checks `exp`. It
  uses `jti` to reject reuse
- A client obtains a token with `com.atproto.server.getServiceAuth(aud, lxm,
  exp)`. Under OAuth, the `rpc` permission (`rpc:<lxm>?aud=<did>`) governs this
  call

Our server already holds the OAuth session of each logged-in user (scope
`atproto transition:generic`, DB-backed). It can make that call on behalf of
the user. This is what the "BFF custody mode" of ADR-0012 needs.

## Decision

### 1. Two kinds of holder proof

A presentation carries one of these proofs:

| Proof | Who can produce it | What it proves |
|-------|--------------------|----------------|
| **AT Proto service-auth token** | Any AT Proto account, via its PDS | The account's PDS — the authority for that DID — vouches that this request is on the account's behalf, to this verifier, now |
| **Key-bound proof** | A device, agent or collective holding its own Ed25519 key | Possession of the specific key the credential was bound to |

The existing nonce challenge (ADR-0017 §4) remains as the key-bound proof.

### 2. Service-auth proof for accounts

The presenter obtains a service-auth JWT with these claims:

- `iss` — the account DID (must equal the `sub` of every presented credential)
- `aud` — the DID of the verifying collective with a service fragment
  (`<collective-did>#tailnet_collective`)
- `lxm` — `app.tailnet.credential.present`. The token is therefore useless for
  anything else, including any real XRPC method
- `exp` — at most 60 seconds out

The verifier does these steps:

1. Resolves `iss` and selects only the `#atproto` verification method
2. Verifies the ES256K / ES256 signature and rejects high-S signatures, as the
   AT Proto cryptography spec requires
3. Requires `aud` to be exactly its own DID plus the fragment. It requires
   `lxm` to be the presentation method. It requires `exp` to be in the future
   and no more than a short maximum away
4. Records `jti` until `exp` and rejects a repeat

This flow has no verifier-issued nonce. The caller cannot choose the `jti` of
the token. Replay protection comes from three controls: the audience binding
(the token is good only at this verifier), the short lifetime, and the `jti`
cache. This flow also removes one round trip.

This custody replaces the assumption of ADR-0012 that someone signs with the
key of the user:

- **Browser / web sessions (BFF):** The platform server calls `getServiceAuth`
  through the stored OAuth session of the user. It presents the resulting token
  server-to-server. The browser still holds nothing.
- **Same-instance traversal:** When the presenter and the verifier are the same
  instance and the user has a live session, the session *is* the proof. The
  system mints no token.

### 3. Key-bound credentials for devices and agents

A Tailscale client, daemon, or agent has no PDS to ask. For these, the
credential itself names the key that can present it. At issuance, the device
supplies an Ed25519 public key. The collective includes it as a confirmation
claim (`cnf.jwk`, RFC 7800). The presenter then signs the nonce of the verifier
with that key. This uses the existing challenge endpoints. The verifier takes
the key from the credential instead of from a DID document.

To issue a key-bound credential, the system needs an authenticated session or
agent token for the subject. Only the account that owns a device can therefore
bind the key of that device.

### 4. Resolver returns typed keys

`PublicKeyResolver.resolve(did)` currently returns a bare key that the code
assumes is EdDSA. We changed it to return the key together with its algorithm
and the verification-method id. It also gains multikey decoding
(`publicKeyMultibase`, base58btc, secp256k1 and P-256 multicodec prefixes).
Callers state which method and algorithms they accept:

- Collective signatures (credentials, CFP messages): `#signing-key`, EdDSA
- Account service-auth tokens: `#atproto`, ES256K / ES256

We added `@atproto/crypto` for multikey parsing and low-S signature
verification. We do not write either by hand.

### 5. OAuth scope

We keep `transition:generic` for now. We add the granular permission
`rpc:app.tailnet.credential.present?aud=*` to the client metadata. The consent
screen then says what the app will do with it. The app also keeps working when
the platform retires transitional scopes. Existing sessions lack the new scope.
The system asks users to authorize again the first time that a proof is needed.

### 6. Correct ADR-0012

This ADR supersedes two items of ADR-0012 for AT Proto accounts. The first is
the "Holder binding" section. The second is the statement that the DID document
of the user contains "the user's public signing key, the root of trust for all
credentials".

## Consequences

- Holder binding works for the actual user base. It uses the mechanism that AT
  Protocol services already use to authenticate accounts to each other.
- The PDS becomes part of the trust path for presentations. A compromised or
  malicious PDS can present the credentials of its users. This is already true
  of everything else about an AT Proto identity. Credentials stay short-lived
  (4–24 hours).
- Presentation by a browser user needs the PDS of the user to be reachable at
  that moment. Key-bound device credentials do not need this.
- The verifier keeps short-lived state (the `jti` cache). It can live in the
  database next to `holder_binding_challenges`.
- The resolver interface changes. The change affects the credential verifier
  and the CFP message verifier.
- A new dependency (`@atproto/crypto`).

## To verify before implementing

These items come from the AT Proto specifications. We did not test them against
a live PDS:

- that `getServiceAuth` succeeds through an OAuth session that holds only
  `transition:generic`, for a custom `lxm` and a `did:web` audience that the
  PDS has never seen;
- whether the PDS requires the audience DID to be resolvable or to declare the
  named service fragment in its DID document (if so, collective DID documents
  gain a `service` entry);
- the maximum `exp` that a PDS grants for a custom `lxm`.

A short spike with a real account against the local instance answers all three
questions.

## Not in scope

- Where the system consumes presentations. No route accepts a credential bundle
  yet. The connection of presentation to traversal (ADR-0011) is separate work.
- Selective disclosure and reputation tokens (ADR-0012).
