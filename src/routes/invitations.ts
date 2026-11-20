/**
 * @module routes/invitations
 * Invitation lifecycle: create (resolve handle via DNS/HTTP/Bluesky API),
 * list sent, list received, accept (provisions Headscale user + membership),
 * decline, and revoke. Gated by the "invite" permission and lockdown mode.
 */

import { Router } from "express";
import { resolveTxt } from "node:dns/promises";
import { eq, and, desc, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { config } from "../config.js";
import {
  users,
  tenants,
  memberships,
  invitations,
} from "../db/schema.js";
import { getControlClient } from "../orchestrator/control-client.js";
import {
  requireAuth,
  param,
  getTenantForUser,
  hasPermission,
  isLockedDown,
  authUserId,
  authUserDid,
} from "./helpers.js";
import { logAudit } from "./audit.js";
import { enforceMemberLimit } from "./limits.js";
import { resolvesToPublicAddresses } from "../identity/resolver.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Router for invitation CRUD: create, list, accept, decline, and revoke. */
export const invitationsRouter = Router();

invitationsRouter.get(
  "/api/tenants/:tenantId/invitations",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "invite", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const rows = await db
      .select({
        id: invitations.id,
        inviteeHandle: invitations.inviteeHandle,
        inviteeDid: invitations.inviteeDid,
        status: invitations.status,
        inviterHandle: users.handle,
        createdAt: invitations.createdAt,
      })
      .from(invitations)
      .innerJoin(users, eq(invitations.inviterUserId, users.id))
      .where(eq(invitations.tenantId, tenantId))
      .orderBy(desc(invitations.createdAt))
      .limit(200);

    res.json(rows.map((r) => ({ ...r, inviteUrl: inviteUrl(r.id) })));
  },
);

const HANDLE_RE =
  /^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

/** AT Proto account DIDs we accept for invitations / tailnet creators. */
export const ACCOUNT_DID_RE = /^did:(plc:[a-z2-7]{24}|web:[a-zA-Z0-9._%:-]{1,253})$/;

/**
 * Canonical form of an account DID so an invitation matches the DID the
 * invitee signs in with: the did:web host part is case-insensitive (lowercased,
 * percent-escapes uppercased); path segments and did:plc ids are left as-is
 * (did:plc is lowercase by construction).
 */
export function normalizeAccountDid(did: string): string {
  if (!did.startsWith("did:web:")) return did;
  const [host, ...path] = did.slice("did:web:".length).split(":");
  const normHost = host.toLowerCase().replace(/%[0-9a-f]{2}/g, (m) => m.toUpperCase());
  return ["did:web:" + normHost, ...path].join(":");
}

/** Timeout for every outbound identity lookup made while inviting. */
const RESOLVE_TIMEOUT_MS = 5000;

/** Copyable link the inviter sends to the invitee. */
export function inviteUrl(invitationId: string): string {
  return `${config.publicUrl.replace(/\/+$/, "")}/invite/${invitationId}`;
}

/**
 * Best-effort DID → handle for display. Uses a known user row, else the
 * did:plc document's `alsoKnownAs`, else the Bluesky public profile; the
 * candidate handle is only trusted if it resolves back to the same DID.
 * Returns null when no verified handle is found.
 */
export async function resolveDidToHandle(did: string): Promise<string | null> {
  const [known] = await db.select({ handle: users.handle }).from(users).where(eq(users.did, did));
  if (known) return known.handle;
  return lookupVerifiedHandle(did);
}

/**
 * The account's current handle from public sources (PLC directory, then the
 * Bluesky public API), accepted only if the handle resolves back to the same
 * DID. Needs no access to the account.
 */
export async function lookupVerifiedHandle(did: string): Promise<string | null> {
  let candidate: string | null = null;
  try {
    if (did.startsWith("did:plc:")) {
      const res = await fetch(`https://plc.directory/${encodeURIComponent(did)}`, {
        signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
        redirect: "error",
      });
      if (res.ok) {
        const doc = (await res.json()) as { alsoKnownAs?: string[] };
        const aka = doc.alsoKnownAs?.find((a) => a.startsWith("at://"));
        if (aka) candidate = aka.slice(5);
      }
    }
    if (!candidate) {
      const res = await fetch(
        `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`,
        { signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS), redirect: "error" },
      );
      if (res.ok) {
        const data = (await res.json()) as { handle?: string };
        if (data.handle && data.handle !== "handle.invalid") candidate = data.handle;
      }
    }
  } catch {
    // fall through — display falls back to the DID
  }
  if (!candidate || !HANDLE_RE.test(candidate)) return null;
  const back = await resolveHandleToDid(candidate);
  return back && normalizeAccountDid(back) === normalizeAccountDid(did) ? candidate : null;
}

/**
 * Resolves an AT Proto handle to its DID (DNS TXT → HTTPS .well-known →
 * Bluesky public API). Shared by invitations and operator tailnet creators.
 */
export async function resolveHandleToDid(handle: string): Promise<string | null> {
  const cleanHandle = handle.replace(/^@/, "");

  if (!HANDLE_RE.test(cleanHandle)) {
    return null;
  }

  try {
    const records = await resolveTxt(`_atproto.${cleanHandle}`);
    const didRecord = records.flat().find((r) => r.startsWith("did="));
    if (didRecord) {
      const did = didRecord.slice(4).trim();
      if (did.startsWith("did:")) return did;
    }
  } catch {
    // DNS resolution failed, try HTTP
  }

  // The handle is user input: only fetch its .well-known when every address
  // it resolves to is public (no probing of internal services), with a
  // timeout and no redirects.
  try {
    if (await resolvesToPublicAddresses(cleanHandle)) {
      const res = await fetch(`https://${cleanHandle}/.well-known/atproto-did`, {
        signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
        redirect: "error",
      });
      if (res.ok) {
        const did = (await res.text()).slice(0, 2048).trim();
        if (did.startsWith("did:")) return did;
      }
    }
  } catch {
    // fall through
  }

  try {
    const res = await fetch(
      `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(cleanHandle)}`,
      { signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS), redirect: "error" },
    );
    if (res.ok) {
      const data = (await res.json()) as { did?: unknown };
      if (typeof data.did === "string" && data.did.startsWith("did:")) return data.did;
    }
  } catch {
    // fall through
  }

  return null;
}

invitationsRouter.post(
  "/api/tenants/:tenantId/invitations",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");

    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "invite", req)) {
      res.status(403).json({ error: "You do not have permission to invite" });
      return;
    }

    if (isLockedDown(result.tenant)) {
      res.status(403).json({ error: "Tenant is in lockdown mode" });
      return;
    }

    const body = (req.body ?? {}) as { handle?: unknown; did?: unknown };
    const handle = typeof body.handle === "string" ? body.handle.trim() : "";
    const didInput = typeof body.did === "string" ? body.did.trim() : "";
    if ((handle ? 1 : 0) + (didInput ? 1 : 0) !== 1) {
      res.status(400).json({ error: "Provide exactly one of handle or did" });
      return;
    }

    let did: string | null;
    let cleanHandle: string;
    if (didInput) {
      if (!ACCOUNT_DID_RE.test(didInput)) {
        res.status(400).json({ error: "did must be a did:plc or did:web identifier" });
        return;
      }
      did = normalizeAccountDid(didInput);
      // Display handle from the DID document when it verifies; else the DID itself
      cleanHandle = (await resolveDidToHandle(did)) ?? did;
    } else {
      cleanHandle = handle.replace(/^@/, "");
      const resolved = await resolveHandleToDid(cleanHandle);
      did = resolved ? normalizeAccountDid(resolved) : null;
      if (!did) {
        res
          .status(404)
          .json({ error: `Could not resolve handle: ${cleanHandle}` });
        return;
      }
    }

    const [existingUser] = await db
      .select()
      .from(users)
      .where(eq(users.did, did));

    if (existingUser) {
      const [existingMembership] = await db
        .select()
        .from(memberships)
        .where(
          and(
            eq(memberships.tenantId, tenantId),
            eq(memberships.userId, existingUser.id),
          ),
        );

      if (existingMembership) {
        res.status(409).json({ error: "User is already a member" });
        return;
      }
    }

    const [existingInvitation] = await db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.tenantId, tenantId),
          eq(invitations.inviteeDid, did),
          eq(invitations.status, "pending"),
        ),
      );

    if (existingInvitation) {
      res.status(409).json({ error: "Invitation already pending" });
      return;
    }

    const [invitation] = await db
      .insert(invitations)
      .values({
        tenantId,
        inviterUserId: authUserId(req),
        inviteeDid: did,
        inviteeHandle: cleanHandle,
      })
      .returning();

    logAudit({
      tenantId,
      actorUserId: authUserId(req),
      action: "invitation_created",
      targetType: "invitation",
      targetId: invitation.id,
      metadata: { handle: cleanHandle, did },
    });

    res.status(201).json({ ...invitation, inviteUrl: inviteUrl(invitation.id) });
  },
);

invitationsRouter.get("/api/invitations", requireAuth, async (req, res) => {
  const did = await authUserDid(req);
  if (!did) {
    res.status(403).json({ error: "Could not resolve user identity" });
    return;
  }

  const pendingInvitations = await db
    .select({
      id: invitations.id,
      tenantId: invitations.tenantId,
      tenantName: tenants.name,
      tenantSlug: tenants.slug,
      inviterHandle: users.handle,
      inviterDisplayName: users.displayName,
      status: invitations.status,
      createdAt: invitations.createdAt,
    })
    .from(invitations)
    .innerJoin(tenants, eq(invitations.tenantId, tenants.id))
    .innerJoin(users, eq(invitations.inviterUserId, users.id))
    .where(
      and(
        eq(invitations.inviteeDid, normalizeAccountDid(did)),
        eq(invitations.status, "pending"),
        ne(tenants.status, "deleted"),
        eq(tenants.suspended, false),
      ),
    )
    .limit(100);

  res.json(pendingInvitations);
});

/**
 * One invitation, for the invitee only (the /invite/:id page). Anyone else
 * signed in gets 404 — the id alone reveals nothing.
 */
invitationsRouter.get(
  "/api/invitations/:invitationId",
  requireAuth,
  async (req, res) => {
    const invitationId = param(req, "invitationId");
    const did = await authUserDid(req);
    if (!did || !UUID_RE.test(invitationId)) {
      res.status(404).json({ error: "Invitation not found" });
      return;
    }

    const [row] = await db
      .select({
        id: invitations.id,
        status: invitations.status,
        tenantId: tenants.id,
        tenantName: tenants.name,
        tenantSlug: tenants.slug,
        tenantStatus: tenants.status,
        tenantSuspended: tenants.suspended,
        inviterHandle: users.handle,
      })
      .from(invitations)
      .innerJoin(tenants, eq(invitations.tenantId, tenants.id))
      .innerJoin(users, eq(invitations.inviterUserId, users.id))
      .where(and(eq(invitations.id, invitationId), eq(invitations.inviteeDid, normalizeAccountDid(did))));

    if (!row || row.tenantStatus === "deleted" || row.tenantSuspended) {
      res.status(404).json({ error: "Invitation not found" });
      return;
    }

    res.json({
      id: row.id,
      tenant: { id: row.tenantId, name: row.tenantName, slug: row.tenantSlug },
      inviterHandle: row.inviterHandle,
      status: row.status,
    });
  },
);

invitationsRouter.post(
  "/api/invitations/:invitationId/accept",
  requireAuth,
  async (req, res) => {
    const invitationId = param(req, "invitationId");
    const did = await authUserDid(req);
    if (!did) {
      res.status(403).json({ error: "Could not resolve user identity" });
      return;
    }

    const [invitation] = await db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.id, invitationId),
          eq(invitations.inviteeDid, normalizeAccountDid(did)),
          eq(invitations.status, "pending"),
        ),
      );

    if (!invitation) {
      res.status(404).json({ error: "Invitation not found" });
      return;
    }

    const [tenant] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, invitation.tenantId));

    // A deleted or suspended tailnet can't be joined — same answer as an
    // unknown invitation.
    if (!tenant || tenant.status === "deleted" || tenant.suspended) {
      res.status(404).json({ error: "Invitation not found" });
      return;
    }

    if (!tenant.apiKey) {
      res.status(500).json({ error: "Tenant instance not available" });
      return;
    }

    if (isLockedDown(tenant)) {
      res.status(403).json({ error: "Tenant is in lockdown mode — cannot accept invitations" });
      return;
    }

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.did, did));

    if (!user) {
      res.status(500).json({ error: "User not found" });
      return;
    }

    if (!(await enforceMemberLimit(res, tenant))) return;

    const hsUsername = user.handle
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase();

    try {
      const client = getControlClient(tenant);
      await client.createUser(hsUsername);
    } catch {
      // User might already exist if they were previously a member
    }

    await db.insert(memberships).values({
      userId: user.id,
      tenantId: tenant.id,
      role: "member",
      roleId: tenant.defaultRoleId,
      isOriginator: false,
    }).onConflictDoNothing();

    await db
      .update(invitations)
      .set({ status: "accepted", updatedAt: new Date() })
      .where(eq(invitations.id, invitationId));

    logAudit({
      tenantId: tenant.id,
      actorUserId: user.id,
      action: "invitation_accepted",
      targetType: "invitation",
      targetId: invitationId,
    });

    res.json({ status: "accepted", tenantId: tenant.id });
  },
);

invitationsRouter.post(
  "/api/invitations/:invitationId/decline",
  requireAuth,
  async (req, res) => {
    const invitationId = param(req, "invitationId");
    const did = await authUserDid(req);
    if (!did) {
      res.status(403).json({ error: "Could not resolve user identity" });
      return;
    }

    const [invitation] = await db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.id, invitationId),
          eq(invitations.inviteeDid, normalizeAccountDid(did)),
          eq(invitations.status, "pending"),
        ),
      );

    if (!invitation) {
      res.status(404).json({ error: "Invitation not found" });
      return;
    }

    await db
      .update(invitations)
      .set({ status: "declined", updatedAt: new Date() })
      .where(eq(invitations.id, invitationId));

    logAudit({
      tenantId: invitation.tenantId,
      actorUserId: authUserId(req),
      action: "invitation_declined",
      targetType: "invitation",
      targetId: invitationId,
    });

    res.json({ status: "declined" });
  },
);

invitationsRouter.delete(
  "/api/tenants/:tenantId/invitations/:invitationId",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const invitationId = param(req, "invitationId");

    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "invite", req)) {
      res.status(403).json({ error: "You do not have permission to revoke invitations" });
      return;
    }

    const [target] = await db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.id, invitationId),
          eq(invitations.tenantId, tenantId),
        ),
      );

    if (!target) {
      res.status(404).json({ error: "Invitation not found" });
      return;
    }

    await db
      .update(invitations)
      .set({ status: "revoked", updatedAt: new Date() })
      .where(
        and(
          eq(invitations.id, invitationId),
          eq(invitations.tenantId, tenantId),
        ),
      );

    logAudit({
      tenantId,
      actorUserId: authUserId(req),
      action: "invitation_revoked",
      targetType: "invitation",
      targetId: invitationId,
    });

    res.json({ status: "revoked" });
  },
);
