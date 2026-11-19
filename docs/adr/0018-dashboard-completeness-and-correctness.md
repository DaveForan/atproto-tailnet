# ADR-0018: Dashboard completeness and correctness

**Status:** Implemented
**Date:** 2026-11-04
**Priority:** P1
**Depends On:** ADR-0016 (federation transport), ADR-0017 (DID resolution)

## Context

The dashboard (inline SPA at `src/routes/dashboard.ts`) has tabs for most
features. But the new modules have no UI at all:

- **Credentials**: 6 API endpoints, zero dashboard UI
- **Federation scoping**: the backend has GET/PUT, but the dashboard has no
  controls
- **Federation DID management**: the backend can view and rotate the DID, but
  the dashboard has no panel
- **Federation broker status**: users cannot observe the runtime state
- **Federation route table**: users cannot see the imported and exported routes

We also found two correctness issues:
- `traversal.ts` and `credentials.ts` do not check `isLockedDown(tenant)`
  before state-changing operations. They bypass the lockdown feature
- The collectives quota endpoint logs the wrong audit action string

## Decision

### 1. Credentials dashboard tab

We added a `tab-credentials` panel with these parts:
- **Issue credential**: a form to select the type (membership, role,
  capability), fill the required fields, and call the issuance endpoint
- **Verify credential**: the user pastes a JWT and the panel shows the
  verification result
- **Holder challenge**: the panel generates a challenge and displays the nonce

We did not build two items. The first is a list of issued credentials and
bundle assembly (the system does not record credentials at issuance). The
second is a revoke control.

### 2. Federation management panels

We extended the existing Federation tab with these sub-sections:
- **Scoping**: view and edit the scopes, region code, coordinates, and scope
  policies
- **Identity**: display the collective DID and the public key fingerprint, and
  show a rotate button
- **Broker sessions**: the session count and, for each session, the peer, the
  status, and the last keepalive
- **Route table**: the exported and imported CIDRs

### 3. Lockdown guard fixes

We added `isLockedDown(tenant)` checks to:
- All state-changing endpoints in `traversal.ts` (PUT policy). POST evaluate is
  read-only, so it needs no guard
- All state-changing endpoints in `credentials.ts` (POST issuance, POST bundle,
  POST revoke)

### 4. Audit action fix

We changed the audit action of the collectives quota endpoint from
`"sub_collective_ejected"` to `"sub_collective_quota_updated"`.

## Consequences

- Users can observe and control all backend functionality from the dashboard
- Lockdown mode now blocks credential issuance and policy changes
- The audit log accurately reflects quota operations
- The credentials tab lets users who do not use the API issue and manage
  credentials
