/**
 * @module routes/credentials
 * Credential issuance, verification, and status endpoints (ADR-0012).
 */

import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  tenants,
  memberships,
  roles,
  users,
  collectiveDids,
  credentialRevocations,
  federationLinks,
  holderBindingChallenges,
} from "../db/schema.js";
import {
  requireAuth,
  param,
  getTenantForUser,
  hasPermission,
  authUserId,
  authUserDid,
  isLockedDown,
  missingPermissions,
} from "./helpers.js";
import { ALL_PERMISSIONS } from "../members/permissions.js";
import { logAudit } from "../audit/log.js";
import { logger } from "../logger.js";
import {
  issueMembershipCredential,
  issueRoleAttestation,
  issueCapabilityToken,
  assembleBundle,
  generateHolderChallenge,
  type IssuerKeyPair,
} from "../credentials/issuer.js";
import { loadCollectiveKeyPair } from "../orchestrator/federation-broker.js";
import { verifyCredential, verifyHolderBinding } from "../credentials/verifier.js";
import { verifyServiceAuth } from "../credentials/service-auth.js";
import { getResolver } from "../identity/resolver.js";
import { config } from "../config.js";
import * as jose from "jose";

export const credentialsRouter = Router();

/** Subject DID from the body (`subjectDid` from the dashboard, `userDid` from API callers). */
function subjectDidFrom(body: unknown): string | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const did = b.subjectDid ?? b.userDid;
  return typeof did === "string" && did.startsWith("did:") && did.length <= 512 ? did : null;
}

/**
 * The subject's membership and role in this tenant, or null when the DID is
 * not a member. Credentials are only issued to members.
 */
async function loadSubjectMember(tenantId: string, did: string) {
  const [row] = await db
    .select({ membership: memberships, role: roles })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .leftJoin(roles, eq(memberships.roleId, roles.id))
    .where(and(eq(memberships.tenantId, tenantId), eq(users.did, did)));
  return row ?? null;
}

/** Permissions a member holds (originators hold all). */
function memberPermissions(
  m: { membership: typeof memberships.$inferSelect; role: typeof roles.$inferSelect | null },
): string[] {
  if (m.membership.isOriginator) return [...ALL_PERMISSIONS];
  return ((m.role?.permissions ?? []) as string[]).filter((p) => (ALL_PERMISSIONS as readonly string[]).includes(p));
}

/** Parse a permission list from an array or a comma-separated string. */
function permissionList(value: unknown): string[] | null {
  const list = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",").map((p) => p.trim()).filter(Boolean)
      : null;
  if (!list || list.length > ALL_PERMISSIONS.length || !list.every((p) => typeof p === "string")) return null;
  return [...new Set(list as string[])];
}

/** The collective's issuer identity, or null if it has no DID yet. */
async function getCollectiveIssuerKeys(tenantId: string): Promise<IssuerKeyPair | null> {
  return loadCollectiveKeyPair(tenantId);
}

credentialsRouter.post(
  "/api/tenants/:tenantId/credentials/membership",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "manage_settings", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    if (isLockedDown(result.tenant)) {
      res.status(403).json({ error: "Tenant is in lockdown mode" });
      return;
    }

    const userDid = subjectDidFrom(req.body);
    if (!userDid) {
      res.status(400).json({ error: "subjectDid is required" });
      return;
    }
    if (!(await loadSubjectMember(tenantId, userDid))) {
      res.status(404).json({ error: "The subject is not a member of this tailnet" });
      return;
    }

    const issuer = await getCollectiveIssuerKeys(tenantId);
    if (!issuer) {
      res.status(412).json({ error: "Collective DID not configured. Create one via the Federation tab first." });
      return;
    }

    const tenantRows = await db
      .select({ name: tenants.name, slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const tenant = tenantRows[0];
    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    try {
      const cred = await issueMembershipCredential(
        issuer,
        {
          collectiveDid: issuer.did,
          collectiveId: tenantId,
          collectiveName: tenant.name,
          joinedAt: new Date().toISOString(),
        },
        userDid,
      );

      logAudit({
        tenantId,
        actorUserId: authUserId(req),
        action: "tenant_settings_updated",
        targetType: "tenant",
        targetId: tenantId,
        metadata: { operation: "credential_issued", type: "membership", subjectDid: userDid },
      });

      res.json({ credential: cred, jwt: cred.jwt });
    } catch (err) {
      logger.error({ tenantId, err }, "failed to issue membership credential");
      res.status(500).json({ error: "Failed to issue credential" });
    }
  },
);

credentialsRouter.post(
  "/api/tenants/:tenantId/credentials/role",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "manage_settings", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    if (isLockedDown(result.tenant)) {
      res.status(403).json({ error: "Tenant is in lockdown mode" });
      return;
    }

    const userDid = subjectDidFrom(req.body);
    if (!userDid) {
      res.status(400).json({ error: "subjectDid is required" });
      return;
    }
    const subject = await loadSubjectMember(tenantId, userDid);
    if (!subject) {
      res.status(404).json({ error: "The subject is not a member of this tailnet" });
      return;
    }
    // The attestation states what the subject's role actually grants. An
    // optional list narrows it; it can never add permissions the subject's
    // role lacks, or that the caller does not hold.
    const held = memberPermissions(subject);
    const requested = req.body?.permissions ?? req.body?.roleName;
    const asked = requested === undefined || requested === "" ? held : permissionList(requested);
    if (!asked) {
      res.status(400).json({ error: "permissions must be a list of permission names" });
      return;
    }
    const notHeldBySubject = asked.filter((p) => !held.includes(p));
    if (notHeldBySubject.length > 0) {
      res.status(400).json({ error: "The subject's role does not grant these permissions", permissions: notHeldBySubject });
      return;
    }
    const lacking = missingPermissions(result.membership, result.role, asked, req);
    if (lacking.length > 0) {
      res.status(403).json({ error: "Cannot attest permissions you do not hold", permissions: lacking });
      return;
    }
    const permissions = asked;

    const issuer = await getCollectiveIssuerKeys(tenantId);
    if (!issuer) {
      res.status(412).json({ error: "Collective DID not configured" });
      return;
    }

    try {
      const cred = await issueRoleAttestation(
        issuer,
        {
          collectiveDid: issuer.did,
          collectiveId: tenantId,
          permissions,
        },
        userDid,
      );

      logAudit({
        tenantId,
        actorUserId: authUserId(req),
        action: "tenant_settings_updated",
        targetType: "tenant",
        targetId: tenantId,
        metadata: { operation: "credential_issued", type: "role", subjectDid: userDid, permissions },
      });

      res.json({ credential: cred, jwt: cred.jwt });
    } catch (err) {
      logger.error({ tenantId, err }, "failed to issue role attestation");
      res.status(500).json({ error: "Failed to issue credential" });
    }
  },
);

credentialsRouter.post(
  "/api/tenants/:tenantId/credentials/capability",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "manage_settings", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    if (isLockedDown(result.tenant)) {
      res.status(403).json({ error: "Tenant is in lockdown mode" });
      return;
    }

    const userDid = subjectDidFrom(req.body);
    if (!userDid) {
      res.status(400).json({ error: "subjectDid is required" });
      return;
    }
    const scope = permissionList(req.body?.scope ?? req.body?.capability);
    if (!scope || scope.length === 0) {
      res.status(400).json({ error: "capability (or scope[]) is required" });
      return;
    }
    const unknown = scope.filter((p) => !(ALL_PERMISSIONS as readonly string[]).includes(p));
    if (unknown.length > 0) {
      res.status(400).json({ error: "Unknown capability", permissions: unknown });
      return;
    }
    const subject = await loadSubjectMember(tenantId, userDid);
    if (!subject) {
      res.status(404).json({ error: "The subject is not a member of this tailnet" });
      return;
    }
    // A capability may only delegate what both the subject and the caller hold.
    const subjectHeld = memberPermissions(subject);
    const notHeldBySubject = scope.filter((p) => !subjectHeld.includes(p));
    if (notHeldBySubject.length > 0) {
      res.status(400).json({ error: "The subject's role does not grant these capabilities", permissions: notHeldBySubject });
      return;
    }
    const lacking = missingPermissions(result.membership, result.role, scope, req);
    if (lacking.length > 0) {
      res.status(403).json({ error: "Cannot grant capabilities you do not hold", permissions: lacking });
      return;
    }
    const rawPath = req.body?.traversalPath;
    if (
      rawPath !== undefined &&
      !(Array.isArray(rawPath) && rawPath.length <= 16 && rawPath.every((d) => typeof d === "string" && d.length <= 512))
    ) {
      res.status(400).json({ error: "traversalPath must be a list of DIDs" });
      return;
    }
    const traversalPath = rawPath as string[] | undefined;

    const issuer = await getCollectiveIssuerKeys(tenantId);
    if (!issuer) {
      res.status(412).json({ error: "Collective DID not configured" });
      return;
    }

    try {
      const cred = await issueCapabilityToken(
        issuer,
        {
          collectiveDid: issuer.did,
          scope,
          traversalPath,
        },
        userDid,
      );

      logAudit({
        tenantId,
        actorUserId: authUserId(req),
        action: "tenant_settings_updated",
        targetType: "tenant",
        targetId: tenantId,
        metadata: { operation: "credential_issued", type: "capability", subjectDid: userDid, scope },
      });

      res.json({ credential: cred, jwt: cred.jwt });
    } catch (err) {
      logger.error({ tenantId, err }, "failed to issue capability token");
      res.status(500).json({ error: "Failed to issue credential" });
    }
  },
);

credentialsRouter.post(
  "/api/tenants/:tenantId/credentials/bundle",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const userId = authUserId(req);
    const result = await getTenantForUser(tenantId, userId);
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (isLockedDown(result.tenant)) {
      res.status(403).json({ error: "Tenant is in lockdown mode" });
      return;
    }

    const userDid = await authUserDid(req);
    if (!userDid) {
      res.status(400).json({ error: "Could not resolve user DID" });
      return;
    }

    const issuer = await getCollectiveIssuerKeys(tenantId);
    if (!issuer) {
      res.status(412).json({ error: "Collective DID not configured" });
      return;
    }

    const tenantRows = await db
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const rolePerms: string[] = result.role?.permissions as string[] ?? [];

    try {
      const membershipCred = await issueMembershipCredential(
        issuer,
        {
          collectiveDid: issuer.did,
          collectiveId: tenantId,
          collectiveName: tenantRows[0]?.name ?? "Unknown",
          joinedAt: result.membership.createdAt.toISOString(),
        },
        userDid,
      );

      const roleCred = await issueRoleAttestation(
        issuer,
        {
          collectiveDid: issuer.did,
          collectiveId: tenantId,
          permissions: rolePerms,
        },
        userDid,
      );

      const bundle = assembleBundle(userDid, [membershipCred, roleCred]);
      res.json({ bundle });
    } catch (err) {
      logger.error({ tenantId, err }, "failed to assemble credential bundle");
      res.status(500).json({ error: "Failed to assemble bundle" });
    }
  },
);

credentialsRouter.get(
  "/api/tenants/:tenantId/credentials/challenge",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const holderDid = req.query.did as string | undefined;
    const challenge = generateHolderChallenge();

    await db.insert(holderBindingChallenges).values({
      tenantId,
      nonce: challenge.nonce,
      holderDid: holderDid ?? null,
      expiresAt: new Date(challenge.expiresAt),
    });

    res.json({ challenge });
  },
);

credentialsRouter.post(
  "/api/tenants/:tenantId/credentials/challenge/verify",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const { nonce, signature, did: holderDid } = req.body ?? {};
    if (!nonce || !signature || !holderDid) {
      res.status(400).json({ error: "nonce, signature, and did are required" });
      return;
    }

    if (typeof nonce !== "string" || typeof signature !== "string" || typeof holderDid !== "string") {
      res.status(400).json({ error: "nonce, signature, and did must be strings" });
      return;
    }

    // Claim the challenge in one statement: it is single-use whatever the
    // outcome, and two concurrent attempts cannot both get it.
    const rows = await db
      .update(holderBindingChallenges)
      .set({ consumed: true })
      .where(
        and(
          eq(holderBindingChallenges.tenantId, tenantId),
          eq(holderBindingChallenges.nonce, nonce),
          eq(holderBindingChallenges.consumed, false),
        ),
      )
      .returning();

    if (rows.length === 0) {
      res.status(404).json({ error: "Challenge not found or already consumed" });
      return;
    }

    const challengeRow = rows[0];
    if (challengeRow.expiresAt < new Date()) {
      res.status(410).json({ error: "Challenge expired" });
      return;
    }

    if (challengeRow.holderDid && challengeRow.holderDid !== holderDid) {
      res.status(403).json({ error: "DID does not match challenge holder" });
      return;
    }

    const resolver = getResolver();
    const verification = await verifyHolderBinding(
      { nonce, signature, did: holderDid },
      {
        nonce: challengeRow.nonce,
        issuedAt: challengeRow.createdAt.toISOString(),
        expiresAt: challengeRow.expiresAt.toISOString(),
      },
      resolver,
    );

    res.json(verification);
  },
);

credentialsRouter.post(
  "/api/credentials/verify",
  async (req, res) => {
    const { jwt } = req.body ?? {};
    if (!jwt || typeof jwt !== "string") {
      res.status(400).json({ error: "jwt string is required" });
      return;
    }

    if (jwt.length > 16_384) {
      res.status(400).json({ error: "jwt too large" });
      return;
    }

    const result = await verifyCredential(jwt, getResolver());
    if (!result.valid) {
      res.json(result);
      return;
    }

    // A good signature is not enough: the issuer may have revoked it.
    const { jti, iss } = jose.decodeJwt(jwt);
    if (jti && iss && (await findRevocation(jti, iss))) {
      res.json({ ...result, valid: false, revoked: true, error: "Credential revoked" });
      return;
    }

    res.json(result);
  },
);

/**
 * Revocation record for a credential. Credential ids (`jti`) are only unique
 * per issuer, so a lookup is always scoped to the issuer that signed it.
 */
async function findRevocation(credentialId: string, issuerDid: string) {
  const [row] = await db
    .select({ revokedAt: credentialRevocations.revokedAt })
    .from(credentialRevocations)
    .where(
      and(
        eq(credentialRevocations.credentialId, credentialId),
        eq(credentialRevocations.issuerDid, issuerDid),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Issuers whose credentials a collective accepts in a presentation: itself,
 * its parent collective, and the peers of its active federation links.
 */
async function trustedIssuerDids(tenantId: string, ownDid: string): Promise<Set<string>> {
  const trusted = new Set<string>([ownDid]);

  const [tenant] = await db
    .select({ parentId: tenants.parentId })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (tenant?.parentId) {
    const [parent] = await db
      .select({ did: collectiveDids.did })
      .from(collectiveDids)
      .where(eq(collectiveDids.tenantId, tenant.parentId))
      .limit(1);
    if (parent) trusted.add(parent.did);
  }

  const peers = await db
    .select({ peerDid: federationLinks.peerDid })
    .from(federationLinks)
    .where(
      and(
        eq(federationLinks.localTenantId, tenantId),
        eq(federationLinks.status, "active"),
      ),
    )
    .limit(200);
  for (const p of peers) trusted.add(p.peerDid);

  return trusted;
}

/**
 * Revoke a credential this collective issued. The caller presents the
 * credential itself: only a JWT signed by this collective's key, whose `jti`
 * is the id being revoked, is accepted — so one tenant can never mark another
 * issuer's credential as revoked.
 */
credentialsRouter.post(
  "/api/tenants/:tenantId/credentials/:credentialId/revoke",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const credentialId = param(req, "credentialId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "manage_settings", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    if (isLockedDown(result.tenant)) {
      res.status(403).json({ error: "Tenant is in lockdown mode" });
      return;
    }

    const { jwt, reason } = req.body ?? {};
    if (typeof jwt !== "string" || !jwt) {
      res.status(400).json({ error: "jwt (the credential being revoked) is required" });
      return;
    }
    if (reason !== undefined && (typeof reason !== "string" || reason.length > 500)) {
      res.status(400).json({ error: "reason must be a string of at most 500 characters" });
      return;
    }

    const issuer = await getCollectiveIssuerKeys(tenantId);
    if (!issuer) {
      res.status(412).json({ error: "Collective DID not configured" });
      return;
    }

    try {
      // Expired credentials may still be revoked; everything else must check out.
      const { payload } = await jose.jwtVerify(jwt, issuer.publicKey, {
        algorithms: ["EdDSA"],
        issuer: issuer.did,
        currentDate: new Date(0),
      });
      if (payload.jti !== credentialId) {
        res.status(400).json({ error: "Credential id does not match the presented credential" });
        return;
      }
    } catch {
      res.status(400).json({ error: "Credential was not issued by this collective" });
      return;
    }

    try {
      await db.insert(credentialRevocations).values({
        credentialId,
        tenantId,
        issuerDid: issuer.did,
        reason: reason ?? null,
      });
    } catch (err: unknown) {
      const pgErr = err as { code?: string; cause?: { code?: string } };
      if (pgErr.code === "23505" || pgErr.cause?.code === "23505") {
        res.status(409).json({ error: "Credential already revoked" });
        return;
      }
      throw err;
    }

    logAudit({
      tenantId,
      actorUserId: authUserId(req),
      action: "credential_revoked",
      targetType: "credential",
      targetId: credentialId,
      metadata: reason ? { reason } : undefined,
    });

    res.json({ status: "revoked", credentialId });
  },
);

credentialsRouter.post(
  "/api/tenants/:tenantId/credentials/present",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const { credentials, serviceAuthToken } = req.body ?? {};
    if (!Array.isArray(credentials) || credentials.length === 0) {
      res.status(400).json({ error: "credentials[] is required" });
      return;
    }
    if (credentials.length > 10) {
      res.status(400).json({ error: "Too many credentials (max 10)" });
      return;
    }

    if (!serviceAuthToken || typeof serviceAuthToken !== "string") {
      res.status(400).json({ error: "serviceAuthToken is required" });
      return;
    }

    const [collectiveDidRow] = await db
      .select({ did: collectiveDids.did })
      .from(collectiveDids)
      .where(eq(collectiveDids.tenantId, tenantId))
      .limit(1);

    if (!collectiveDidRow) {
      res.status(412).json({ error: "Collective DID not configured" });
      return;
    }

    const authResult = await verifyServiceAuth(
      serviceAuthToken,
      collectiveDidRow.did,
    );
    if (!authResult.valid) {
      res.status(401).json({ error: `Service-auth failed: ${authResult.error}` });
      return;
    }

    const resolver = getResolver();
    const trusted = await trustedIssuerDids(tenantId, collectiveDidRow.did);
    const verificationResults = [];
    const errors: string[] = [];

    for (const jwt of credentials) {
      if (typeof jwt !== "string" || jwt.length > 16_384) {
        errors.push("credential must be a string of at most 16384 characters");
        continue;
      }
      // Check the claimed issuer before resolving anything: a self-issued
      // did:web VC is well-signed but says nothing about membership.
      let claimed: { iss?: string; jti?: string };
      try {
        claimed = jose.decodeJwt(jwt);
      } catch {
        errors.push("credential is not a JWT");
        continue;
      }
      if (!claimed.iss || !trusted.has(claimed.iss)) {
        const rejected = { valid: false, issuer: claimed.iss, error: "Issuer is not a trusted collective" };
        verificationResults.push(rejected);
        errors.push(`issuer ${claimed.iss ?? "(none)"} is not a trusted collective`);
        continue;
      }
      const result = await verifyCredential(jwt, resolver);
      verificationResults.push(result);
      if (!result.valid) {
        errors.push(result.error ?? "verification failed");
        continue;
      }
      if (!claimed.jti || (await findRevocation(claimed.jti, result.issuer!))) {
        result.valid = false;
        result.error = claimed.jti ? "Credential revoked" : "Credential has no id";
        errors.push(result.error);
        continue;
      }
      if (result.subject !== authResult.issuerDid) {
        errors.push(
          `credential subject ${result.subject} does not match presenter ${authResult.issuerDid}`,
        );
        result.valid = false;
      }
    }

    res.json({
      valid: errors.length === 0,
      presenterDid: authResult.issuerDid,
      results: verificationResults,
      errors,
    });
  },
);

/**
 * Public revocation status. `?issuer=<did>` is required: credential ids are
 * only unique per issuer, and one collective's revocation must never make
 * another issuer's credential with the same id read as revoked.
 */
credentialsRouter.get(
  "/.well-known/collective-credential-status/:credentialId",
  async (req, res) => {
    const issuer = req.query.issuer;
    if (typeof issuer !== "string" || !issuer.startsWith("did:") || issuer.length > 512) {
      res.status(400).json({ error: "issuer query parameter (the issuer DID) is required" });
      return;
    }
    const revocation = await findRevocation(param(req, "credentialId"), issuer);

    if (revocation) {
      res.json({
        status: "revoked",
        revokedAt: revocation.revokedAt.toISOString(),
        checked: new Date().toISOString(),
      });
      return;
    }

    res.json({
      status: "valid",
      checked: new Date().toISOString(),
    });
  },
);
