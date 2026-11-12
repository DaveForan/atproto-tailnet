---
title: Federation
---

# Federation

Federation connects separate mesh networks (collectives) so devices in one network can reach devices in another. Each side retains full control over what routes are shared, who can connect, and whether to accept or reject link proposals.

## Concepts

### Collectives

A **collective** is a tenant's mesh network viewed as a federation participant. Each collective has:

- A **DID identity**: `did:web:<host>:collective:<slug>` --- a decentralized identifier published as a DID document at `/.well-known/did.json` under the collective's subdomain.
- A **signing key**: Ed25519 keypair. The private key is encrypted at rest with AES-256-GCM. Used to sign all outbound federation messages.
- A **discovery document**: Published metadata including the collective's DID, federation policy (posture), broker endpoint URL, and supported protocol versions.

### Collective Federation Protocol (CFP)

CFP is the wire protocol for inter-collective communication. It runs as JSON messages over HTTPS, authenticated by detached JWS signatures over the raw request body. Every message carries a `CFP-Recipient` header identifying the target collective by DID.

### Federation posture

Each collective has a **federation posture** that controls how it responds to inbound link requests from strangers:

| Posture | Behavior | Route visibility |
|---------|----------|-----------------|
| **Closed** | Refuses all inbound link requests. The collective is invisible to federation. | Hidden from parent tenants in hierarchy. |
| **Selective** | Inbound requests are queued for the operator to review. The operator sees the requesting collective's DID and proposed CIDRs, and decides whether to accept or reject. | Visible to parent tenants. |
| **Open** | Currently identical to selective (operator approval required). Reserved for future auto-accept under traversal policy. | Visible to parent tenants. |

**Closed** is the default for new tenants. Most production deployments should use **selective**.

Two additional gates layer on top of posture:

- **Lockdown mode**: Blocks all inbound requests and prevents sending outbound ones, regardless of posture setting.
- **Abuse controls**: Rate limits per sender DID (60 req/min), per source IP, a cap on pending inbound requests, replay guard with a 5-minute window, and a 2 MiB body size limit.

## How federation works

### Establishing a link

The lifecycle of a federation link follows this sequence:

<ol class="steps">
<li>

**Link request**

One collective sends a `LINK_REQUEST` to another, proposing shared CIDR prefixes. The request includes the sender's DID and a signed description of which IP ranges it wants to share.

</li>
<li>

**Operator review**

If the recipient's posture is `selective` (or `open`), the request appears in the **Federation** tab of the recipient's dashboard. The operator reviews:

- The requesting collective's DID and domain
- The proposed CIDR prefixes
- Whether the prefixes conflict with existing routes

The operator can **accept** or **reject**.

</li>
<li>

**Session handshake**

On acceptance, the accepting side initiates a CFP session handshake:

```
Acceptor                          Requester
   │                                  │
   ├── HELLO (signed) ───────────────►│
   │                                  │
   │◄────────── CHALLENGE (nonce) ────┤
   │                                  │
   ├── COMMIT (signed nonce) ────────►│
   │                                  │
   │◄───────── ESTABLISHED ──────────┤
   │                                  │
```

Both sides verify signatures against the peer's DID document public key at each step.

</li>
<li>

**Route exchange**

Once established, both sides exchange signed route announcements via periodic `KEEPALIVE` messages (every 30 seconds). Only prefixes agreed upon in the link are imported --- `filterImportedPrefixes` rejects anything outside the agreed scope.

Imported routes are installed as auto-approved routes for a special `tag:federation-relay` tag, so the data plane handles packet forwarding.

</li>
<li>

**Ongoing**

Either side can **revoke** the link at any time, which tears down the session and removes imported routes.

</li>
</ol>

### CIDR validation

Before a link is established, shared CIDRs are validated:

- A collective can only offer prefixes inside its own tailnet range or approved subnet routes
- A peer's offered prefixes must not overlap the local collective's own range
- Prefixes must not overlap any other active link's shared ranges
- Default routes (`0.0.0.0/0`, `::/0`) are rejected

### Route scoping

Routes learned through federation carry scope metadata:

| Scope | Priority | Description |
|-------|----------|-------------|
| **Local** | 300 | Peers within ~50 km (measured by geographic coordinates) |
| **Regional** | 200 | Same broad region |
| **Global** | 100 | Any distance |

When multiple paths exist to the same prefix, the coordinator selects the best route by:
1. Lowest measured latency (if available)
2. Highest scope priority + preference score (if no latency data)

## Setting up federation

### Prerequisites

- Two running atproto-tailnet instances (can be on the same or different servers)
- Each instance must have a public HTTPS URL (federation messages are sent over the internet)
- `FEDERATION_KEY_ENCRYPTION_KEY` must be set in `.env` (64 hex characters)

### Configure posture

Set your collective's federation posture via the dashboard **Federation** tab or the API:

```bash
curl -X PUT https://yourdomain.com/api/tenants/<tenant-id>/posture \
  -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" \
  -d '{"posture": "selective"}'
```

### Send a link request

From the **Federation** tab, enter the peer collective's DID (`did:web:...`) and the CIDR prefixes you want to share. The system resolves the peer's DID document, discovers the broker endpoint, and sends a signed `LINK_REQUEST`.

### Accept a link request

When a link request arrives, it appears in your **Federation** tab as a pending request. Review the sender's identity and proposed CIDRs, then accept or reject.

### Monitor active links

Active federation links show in the dashboard with:
- Session status (connecting, established, error)
- Shared prefixes
- Last keepalive timestamp
- Peer collective identity

### Revoke a link

Click **Revoke** on any active link. This sends a `REVOKE` message to the peer, tears down the session, and removes all imported routes.

## Sub-collective hierarchy

Tenants can form a parent/child hierarchy (limited to two levels):

```
Parent collective
  ├── Child A (posture: selective)  → routes visible to parent
  ├── Child B (posture: closed)     → routes hidden from parent
  └── Child C (posture: open)       → routes visible to parent
```

A parent tenant sees aggregated routes from all non-closed children in its route table and streaming map updates. This allows organizational structures where a parent network provides shared infrastructure while children maintain independent control over their federation posture.

## Security considerations

- **Signature verification**: Every federation message is signed and verified against the sender's DID document public key. Signatures are computed over the raw request bytes (not parsed/re-serialized JSON) to prevent canonicalization attacks.

- **Replay protection**: Message IDs are tracked for 5 minutes. Replayed messages are rejected.

- **Rate limiting**: 60 requests per minute per sender DID. Source IP rate limiting is also applied.

- **SSRF defense**: Outbound federation requests resolve hostnames and reject private IP addresses (DNS rebinding guard). Only HTTPS with default ports is allowed.

- **Pending request cap**: Each collective has a maximum number of pending inbound link requests. Oldest pending requests expire when the cap is reached.

- **Lockdown override**: Activating lockdown mode on a tenant immediately blocks all federation activity regardless of posture, both inbound and outbound.
