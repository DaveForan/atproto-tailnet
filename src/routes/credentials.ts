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
  collectiveDids,
  credentialRevocations,
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
} from "./helpers.js";
import { logAudit } from "./audit.js";
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
import { getResolver } from "../identity/resolver.js";
import { config } from "../config.js";
import * as jose from "jose";

export const credentialsRouter = Router();

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

    const { userDid } = req.body ?? {};
    if (!userDid) {
      res.status(400).json({ error: "userDid is required" });
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

      res.json({ credential: cred });
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

    const { userDid, permissions } = req.body ?? {};
    if (!userDid || !Array.isArray(permissions)) {
      res.status(400).json({ error: "userDid and permissions[] are required" });
      return;
    }

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

      res.json({ credential: cred });
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

    const { userDid, scope, traversalPath } = req.body ?? {};
    if (!userDid || !Array.isArray(scope)) {
      res.status(400).json({ error: "userDid and scope[] are required" });
      return;
    }

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

      res.json({ credential: cred });
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

/** Revocation record for a credential id, optionally limited to one issuer. */
async function findRevocation(credentialId: string, issuerDid?: string) {
  const [row] = await db
    .select({ revokedAt: credentialRevocations.revokedAt })
    .from(credentialRevocations)
    .where(
      issuerDid
        ? and(
            eq(credentialRevocations.credentialId, credentialId),
            eq(credentialRevocations.issuerDid, issuerDid),
          )
        : eq(credentialRevocations.credentialId, credentialId),
    )
    .limit(1);
  return row ?? null;
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

credentialsRouter.get(
  "/.well-known/collective-credential-status/:credentialId",
  async (req, res) => {
    const revocation = await findRevocation(param(req, "credentialId"));

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
