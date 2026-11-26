---
title: Federation
---

# Federation

> **Status: off by default.** Federation is not available on a standard instance. The code exists, but the service hides it unless you set `FEDERATION_ENABLED=true`. Keep it off for these reasons:
>
> - Federation is deferred (ADR-0033). Its relay containers need the Docker socket, and the standard stack does not mount it.
> - Cross-instance traffic is not implemented. Links carry no traffic.
>
> When federation is off, the federation and traversal API paths return 404. The broker does not start. The dashboard hides the **Federation**, **Traversal policy** and **Credentials** settings sections. The Rust federation endpoints also need `COORD_FEDERATION_ENABLED=true`. The rest of this guide describes the design and the code.

Federation connects separate mesh networks (collectives). Devices in one network can then reach devices in another network. Each side keeps full control of the routes it shares and of the users who can connect. Each side also decides to accept or reject link proposals.

## Concepts

### Collectives

A **collective** is the mesh network of a tenant, seen as a federation participant. Each collective has these items:

- A **DID identity**: `did:web:<host>:collective:<slug>` --- a decentralized identifier. The collective publishes it as a DID document at `/.well-known/did.json` under the collective's subdomain.
- A **signing key**: an Ed25519 keypair. The system encrypts the private key at rest with AES-256-GCM. The collective uses the key to sign all outbound federation messages.
- A **discovery document**: published metadata. It contains the collective's DID, the federation policy (posture), the broker endpoint URL, and the supported protocol versions.

### Collective Federation Protocol (CFP)

CFP is the wire protocol for communication between collectives. It sends JSON messages over HTTPS. Detached JWS signatures over the raw request body authenticate the messages. Each message carries a `CFP-Recipient` header that identifies the target collective by DID.

### Federation posture

Each collective has a **federation posture**. The posture controls how the collective responds to inbound link requests from strangers:

| Posture | Behavior | Route visibility |
|---------|----------|-----------------|
| **Closed** | Refuses all inbound link requests. The collective is invisible to federation. | Hidden from parent tenants in hierarchy. |
| **Selective** | Queues inbound requests for the operator to review. The operator sees the DID and proposed CIDRs of the requesting collective. The operator then accepts or rejects the request. | Visible to parent tenants. |
| **Open** | Is identical to selective at this time (operator approval is required). Reserved for future auto-accept under traversal policy. | Visible to parent tenants. |

**Closed** is the default for new tenants. Most production deployments must use **selective**.

Two more gates apply on top of the posture:

- **Lockdown mode**: Blocks all inbound requests and prevents outbound requests. The posture setting does not change this.
- **Abuse controls**: These controls are:
  - A rate limit per sender DID (60 req/min)
  - A rate limit per source IP
  - A cap on pending inbound requests
  - A replay guard with a 5-minute window
  - A body size limit of 2 MiB

## How federation works

### Establishing a link

A federation link follows this sequence:

<ol class="steps">
<li>

**Link request**

One collective sends a `LINK_REQUEST` to another collective. The request proposes shared CIDR prefixes. It includes the DID of the sender and a signed description of the IP ranges that the sender wants to share.

</li>
<li>

**Operator review**

If the posture of the recipient is `selective` (or `open`), the request appears under **Settings → Federation** in the recipient's dashboard. The operator reviews these items:

- The DID and domain of the requesting collective
- The proposed CIDR prefixes
- Conflicts between the prefixes and existing routes

The operator can **accept** or **reject** the request.

</li>
<li>

**Session handshake**

After acceptance, the accepting side starts a CFP session handshake:

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

At each step, both sides verify the signatures against the public key in the DID document of the peer.

</li>
<li>

**Route exchange**

After the session is established, both sides exchange signed route announcements in periodic `KEEPALIVE` messages (every 30 seconds). The system imports only the prefixes that the link specifies. `filterImportedPrefixes` rejects all prefixes outside the agreed scope.

The system installs imported routes as auto-approved routes for the special tag `tag:federation-relay`. The data plane then forwards the packets.

</li>
<li>

**Ongoing**

Each side can **revoke** the link at any time. Revocation tears down the session and removes the imported routes.

</li>
</ol>

### CIDR validation

The system validates the shared CIDRs before it establishes a link:

- A collective can offer only prefixes inside its own tailnet range or approved subnet routes.
- The prefixes that a peer offers must not overlap the range of the local collective.
- Prefixes must not overlap the shared ranges of any other active link.
- The system rejects default routes (`0.0.0.0/0`, `::/0`).

### Route scoping

Routes that the system learns through federation carry scope metadata:

| Scope | Priority | Description |
|-------|----------|-------------|
| **Local** | 300 | Peers within about 50 km (measured by geographic coordinates) |
| **Regional** | 200 | Same broad region |
| **Global** | 100 | Any distance |

When more than one path exists to the same prefix, the coordinator selects the best route with these rules:

1. Select the lowest measured latency (if latency data is available).
2. If no latency data is available, select the highest scope priority plus preference score.

## Setting up federation

### Prerequisites

- Two running atproto-tailnet instances (the instances can be on the same server or on different servers)
- A public HTTPS URL for each instance (federation messages travel over the internet)
- `FEDERATION_KEY_ENCRYPTION_KEY` in `.env` (64 hex characters)
- `FEDERATION_ENABLED=true` in `.env` on each instance
- The Docker socket mounted into the app container, and `FEDERATION_RELAY_NETWORK`, for the relay containers (see the status note above)

### Configure posture

Set the federation posture of your collective under **Settings → Federation** in the dashboard or with the API:

```bash
curl -X PUT https://yourdomain.com/api/tenants/<tenant-id>/federation/posture \
  -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" \
  -d '{"posture": "selective"}'
```

### Send a link request

Under **Settings → Federation**, enter the DID of the peer collective (`did:web:...`). Then enter the CIDR prefixes that you want to share. The system resolves the DID document of the peer and discovers the broker endpoint. Then it sends a signed `LINK_REQUEST`.

### Accept a link request

When a link request arrives, it appears under **Settings → Federation** as a pending request. Review the identity of the sender and the proposed CIDRs. Then accept or reject the request.

### Monitor active links

The dashboard shows these items for each active federation link:

- Session status (connecting, established, error)
- Shared prefixes
- Timestamp of the last keepalive
- Identity of the peer collective

### Revoke a link

Click **Revoke** on an active link. This action sends a `REVOKE` message to the peer. It also tears down the session and removes all imported routes.

## Sub-collective hierarchy

Tenants can form a parent/child hierarchy. The hierarchy has a maximum of two levels:

```
Parent collective
  ├── Child A (posture: selective)  → routes visible to parent
  ├── Child B (posture: closed)     → routes hidden from parent
  └── Child C (posture: open)       → routes visible to parent
```

A parent tenant sees the aggregated routes from all children that are not closed. The parent sees these routes in its route table and in streaming map updates. This structure lets a parent network provide shared infrastructure. The children keep independent control of their federation posture.

## Security considerations

- **Signature verification**: The system signs each federation message and verifies it against the public key in the DID document of the sender. The signatures cover the raw request bytes (not parsed or re-serialized JSON). This prevents canonicalization attacks.

- **Replay protection**: The system tracks message IDs for 5 minutes. It rejects replayed messages.

- **Rate limiting**: The limit is 60 requests per minute per sender DID. The system also applies a rate limit per source IP.

- **SSRF defense**: Outbound federation requests resolve hostnames and reject private IP addresses (DNS rebinding guard). The system allows only HTTPS with default ports.

- **Pending request cap**: Each collective has a maximum number of pending inbound link requests. When the cap is reached, the oldest pending requests expire.

- **Lockdown override**: When you activate lockdown mode on a tenant, the system immediately blocks all federation activity, inbound and outbound. The posture does not change this.
