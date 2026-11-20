# ADR-0035: Device-bound access

**Status:** Proposed
**Date:** 2026-11-20
**Priority:** P0
**Depends On:** ADR-0003 (AT Proto OAuth), ADR-0005 (security management), ADR-0032 (device sign-in)

## Context

The AT Protocol account is the only proof of identity. If an attacker takes
control of the account (password, session theft, or control of the PDS or the
handle), the attacker can:

- Sign in to the dashboard as the user, with all the permissions of the user.
  For an operator, that is the full instance.
- Create auth keys and add devices to every tailnet of the user.
- Approve MCP connections and create agent tokens.

The existing device lock (`device_locks`) binds a membership to machine keys.
It has these limits:

- A holder of `lock_devices` sets it for a member. A member cannot lock
  themselves.
- It only blocks new auth keys in the TS service. The coordinator does not
  enforce it. A key that exists can still enroll a new machine.
- It does not protect the dashboard sign-in. An attacker who signs in as the
  user can remove the lock.

The operator requires: a user can lock access to a fixed set of devices, can
limit the number of devices, and logins and connections from any other device
are refused automatically, also when the account is compromised.

## Decision

Two locks that work together. Both are per user and off by default.

### 1. Sign-in lock: trusted devices (passkeys)

A **trusted device** is a WebAuthn credential (passkey) that a browser on that
device holds. The private key stays in the secure hardware of the device and
cannot be copied. This identifies the device with cryptography. It is stronger
than a profile of browser properties, which an attacker can copy.

- A user registers the current device as trusted. The record holds the public
  key, a name, the time, and the last use.
- When a user has one or more trusted devices, sign-in has two steps: the AT
  Protocol sign-in identifies the account, then the browser must prove a
  trusted device (a WebAuthn assertion with user verification). Without the
  second step there is no session.
- **A sign-in from another device is refused.** The user gets a notification
  with the time and the network address of the attempt.
- **Device limit.** The user sets the maximum number of trusted devices (1 or
  more). Registration of a device above the limit is refused.
- **Adding a device** needs an approval from a trusted device: the new device
  shows a short code, and the user confirms it on a trusted device with an
  assertion. A compromised account alone cannot add a device.
- **Step-up.** These actions need a new assertion from a trusted device, not
  only a session: change of trusted devices or limits, removal of a lock,
  creation of agent tokens, approval of MCP connections, operator actions, and
  change of the tailnet address.
- MCP connections and agent tokens that exist are listed for review when the
  lock is turned on. The user can revoke them in the same step.

### 2. Tailnet lock: enrolled machines

- A user can lock their own devices in a tailnet (**self-lock**), in addition
  to the lock that a `lock_devices` holder sets.
- The lock is a set of machine keys and a maximum number of devices.
- **The coordinator enforces it.** At registration, the coordinator refuses a
  machine key that is not in the set when the owner is locked, also when the
  auth key is valid, and also in the interactive sign-in (ADR-0032). The
  coordinator keeps the lock in its store, so the rule also holds when the TS
  service is not available.
- A refused registration creates a notification for the user and for the
  approvers of the tailnet.
- Removal of the lock, or a new machine, needs a step-up from a trusted device
  (section 1). If the user has no trusted device, the existing rules apply
  (`lock_devices` holders).

### 3. Recovery

A user who loses all trusted devices cannot sign in. Recovery options, in this
order:

1. **Recovery codes.** At the time of the first registration, the service
   shows single-use codes. The service stores only hashes. A code replaces the
   device proof one time and forces the registration of a new trusted device.
2. **Operator reset.** An instance operator can remove the trusted devices of a
   user after a check outside the system. The audit log records it. The user
   gets a notification, and the reset takes effect after a delay (24 hours) in
   which a trusted device of the user can cancel it.
3. An operator who loses all devices and codes recovers with access to the
   server (a command that needs the database).

### 4. Implementation rules

- WebAuthn verification is our code, with `node:crypto` and a small CBOR
  decoder for the public key. No authentication library. Supported algorithms:
  ES256 and EdDSA (RS256 for older Windows authenticators).
- Attestation type `none`: the service does not check the maker of the
  authenticator.
- Challenges are random, single-use, bound to the session, and expire after 5
  minutes. The service checks the origin, the relying-party ID hash, the
  user-verified flag and the signature counter.
- The relying-party ID is the dashboard host. Passkeys are thus bound to this
  instance.

### Later

When the gateway exists (ADR-0029), a second proof is possible: a browser that
reaches the dashboard over the tailnet from an enrolled machine. The source
address then identifies the machine.

## Consequences

- A stolen AT Protocol account is not enough to sign in, to add a device, or
  to remove the locks.
- Users must keep a trusted device or the recovery codes. The documentation
  must make this clear before the user turns on the lock.
- Agent tokens stay a path that does not use a device. Their creation needs a
  step-up, and their permissions stay limited.
- The service gets its first second factor. Sessions get a record of the
  trusted device that made them.

## Acceptance

- With one trusted device: sign-in from a second browser, with the correct AT
  Protocol account, is refused and creates a notification.
- A third device cannot be added when the limit is 2.
- With a tailnet self-lock: a valid auth key cannot enroll a new machine; the
  coordinator refuses it.
- Removal of a lock without a trusted-device assertion is refused.
- A recovery code works one time.
