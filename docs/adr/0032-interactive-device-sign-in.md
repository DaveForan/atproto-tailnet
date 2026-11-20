# ADR-0032: Interactive device sign-in with Bluesky

**Status:** Proposed
**Date:** 2026-11-19
**Priority:** P1
**Depends On:** ADR-0003 (AT Proto OAuth), ADR-0023 (Rust mesh coordinator), ADR-0026 (shared control URL)

## Context

Devices join a tailnet only with a pre-auth key. If a device registers without
a key, the coordinator returns `AuthURL: https://example.com/register`
(`coordinator/crates/coord-api/src/control.rs`). This is a placeholder.

Effects:

- Phones are difficult to add. Some Tailscale apps (iOS) have no field for an
  auth key. They open the auth URL in a browser.
- On every platform, a member must copy a key from the dashboard to the
  device.
- Adding a second profile for another tailnet is difficult.

## Decision

Implement the interactive login flow of the Tailscale control protocol.

1. A device registers without a key. The coordinator creates a pending
   registration with a random, single-use ID and a short expiry (10 minutes).
   It returns `AuthURL: https://<APEX_DOMAIN>/device/<id>`.
2. The device keeps its map request open and waits.
3. The user opens the URL, signs in with Bluesky, and sees the device name and
   OS. The user selects the tailnet and approves.
4. The TS service tells the coordinator to complete the registration with the
   tailnet and owner. The waiting device receives an authorized response.

Rules:

- All checks that apply to auth keys apply here: device approval, device
  limits, device locks, lockdown, suspension.
- If the tailnet requires device approval, the request goes to approvers.
- The approval page shows the machine key fingerprint. It refuses expired and
  used IDs.
- Rate limits apply to pending registrations.

## Consequences

- Phones and laptops join with a sign-in. No key copy is necessary.
- The placeholder URL is removed.
- Auth keys stay available for servers and automation.

## Acceptance

- The iOS and Android apps join with the shared control URL and a Bluesky
  sign-in.
- An expired or used link shows an error and registers nothing.
- A device in a tailnet in lockdown cannot complete the flow.
