# ADR-0018: Dashboard completeness and correctness

**Status:** Implemented
**Date:** 2026-11-04
**Priority:** P1
**Depends On:** ADR-0016 (federation transport), ADR-0017 (DID resolution)

## Context

The dashboard (inline SPA at `src/routes/dashboard.ts`) has tabs for most
features but several new modules lack UI entirely:

- **Credentials**: 6 API endpoints, zero dashboard UI
- **Federation scoping**: backend GET/PUT exists, no dashboard controls
- **Federation DID management**: view/rotate DID, no dashboard panel
- **Federation broker status**: runtime state not observable
- **Federation route table**: imported/exported routes not visible

Additionally, two correctness issues were found:
- `traversal.ts` and `credentials.ts` don't check `isLockedDown(tenant)`
  before state-changing operations, bypassing the lockdown feature
- The collectives quota endpoint logs the wrong audit action string

## Decision

### 1. Credentials dashboard tab

Add a `tab-credentials` panel with:
- **Issue credential**: form to select type (membership, role, capability),
  fill required fields, call the issuance endpoint
- **Verify credential**: paste a JWT, show the verification result
- **Holder challenge**: generate a challenge, display the nonce

Not built: listing issued credentials / assembling bundles (credentials are
not recorded at issuance) and a revoke control.

### 2. Federation management panels

Extend the existing Federation tab with sub-sections:
- **Scoping**: view/edit scopes, region code, coordinates, scope policies
- **Identity**: display collective DID, public key fingerprint, rotate button
- **Broker sessions**: session count, and per session the peer, status and
  last keepalive
- **Route table**: exported and imported CIDRs

### 3. Lockdown guard fixes

Add `isLockedDown(tenant)` checks to:
- All state-changing endpoints in `traversal.ts` (PUT policy, POST evaluate
  is read-only so no guard needed)
- All state-changing endpoints in `credentials.ts` (POST issuance, POST
  bundle, POST revoke)

### 4. Audit action fix

Change the collectives quota endpoint audit action from
`"sub_collective_ejected"` to `"sub_collective_quota_updated"`.

## Consequences

- All backend functionality is observable and controllable from the dashboard
- Lockdown mode properly blocks credential issuance and policy changes
- Audit log accurately reflects quota operations
- The credentials tab enables non-API users to issue and manage credentials
