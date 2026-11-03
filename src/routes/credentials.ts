/**
 * @module routes/credentials
 * Credential issuance, verification, and status endpoints (ADR-0012).
 */

import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants, memberships, roles, collectiveDids } from "../db/schema.js";
import {
  requireAuth,
  param,
  getTenantForUser,
  hasPermission,
  authUserId,
  authUserDid,
} from "./helpers.js";
import { logAudit } from "./audit.js";
import { logger } from "../logger.js";
import {
  issueMembershipCredential,
  issueRoleAttestation,
  issueCapabilityToken,
  assembleBundle,
  generateHolderChallenge,
  importIssuerKeyPair,
} from "../credentials/issuer.js";
import { verifyCredential } from "../credentials/verifier.js";
import { config } from "../config.js";
import * as jose from "jose";

export const credentialsRouter = Router();

async function getCollectiveIssuerKeys(tenantId: string) {
  const rows = await db
    .select({
      did: collectiveDids.did,
      publicKeyJwk: collectiveDids.publicKeyJwk,
      encryptedPrivateKey: collectiveDids.encryptedPrivateKey,
    })
    .from(collectiveDids)
    .where(eq(collectiveDids.tenantId, tenantId))
    .limit(1);

  if (rows.length === 0) return null;
  const row = rows[0];

  const encKey = process.env.FEDERATION_KEY_ENCRYPTION_KEY;
  let privateKeyJwk: jose.JWK;

  if (encKey) {
    const { createDecipheriv } = await import("node:crypto");
    const keyBuf = Buffer.from(encKey, "base64");
    const raw = Buffer.from(row.encryptedPrivateKey, "base64");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const ciphertext = raw.subarray(12, raw.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", keyBuf, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    privateKeyJwk = JSON.parse(decrypted.toString("utf8"));
  } else {
    privateKeyJwk = JSON.parse(
      Buffer.from(row.encryptedPrivateKey, "base64").toString("utf8"),
    );
  }

  const publicKeyJwk = typeof row.publicKeyJwk === "string"
    ? JSON.parse(row.publicKeyJwk)
    : row.publicKeyJwk;

  return importIssuerKeyPair(row.did, privateKeyJwk, publicKeyJwk);
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

    const challenge = generateHolderChallenge();
    res.json({ challenge });
  },
);

credentialsRouter.get(
  "/.well-known/collective-credential-status/:credentialId",
  async (_req, res) => {
    // Stub: all credentials are valid unless explicitly revoked
    // Full implementation would check a revocation store
    res.json({
      status: "valid",
      checked: new Date().toISOString(),
    });
  },
);
