/**
 * @module routes/invitations
 * Invitation lifecycle: create (resolve handle via DNS/HTTP/Bluesky API),
 * list sent, list received, accept (provisions Headscale user + membership),
 * decline, and revoke. Gated by the "invite" permission and lockdown mode.
 */

import { Router } from "express";
import { resolveTxt } from "node:dns/promises";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  users,
  tenants,
  memberships,
  invitations,
} from "../db/schema.js";
import { HeadscaleApiClient } from "../orchestrator/headscale-api.js";
import {
  requireAuth,
  param,
  getTenantForUser,
  hasPermission,
  isLockedDown,
} from "./helpers.js";
import { logAudit } from "./audit.js";

/** Router for invitation CRUD: create, list, accept, decline, and revoke. */
export const invitationsRouter = Router();

invitationsRouter.get(
  "/api/tenants/:tenantId/invitations",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, req.session.userId!);
    if (!result) {
      res.status(403).json({ error: "Not a member of this tenant" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "invite")) {
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

    res.json(rows);
  },
);

const HANDLE_RE =
  /^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

async function resolveHandleToDid(handle: string): Promise<string | null> {
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

  try {
    const res = await fetch(
      `https://${cleanHandle}/.well-known/atproto-did`,
    );
    if (res.ok) {
      const did = (await res.text()).trim();
      if (did.startsWith("did:")) return did;
    }
  } catch {
    // fall through
  }

  try {
    const res = await fetch(
      `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(cleanHandle)}`,
    );
    if (res.ok) {
      const data = (await res.json()) as { did: string };
      return data.did;
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
    const { handle } = req.body as { handle: string };

    if (!handle) {
      res.status(400).json({ error: "handle is required" });
      return;
    }

    const result = await getTenantForUser(tenantId, req.session.userId!);
    if (!result) {
      res.status(403).json({ error: "Not a member of this tenant" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "invite")) {
      res.status(403).json({ error: "You do not have permission to invite" });
      return;
    }

    if (isLockedDown(result.tenant)) {
      res.status(403).json({ error: "Tenant is in lockdown mode" });
      return;
    }

    const cleanHandle = handle.replace(/^@/, "");
    const did = await resolveHandleToDid(cleanHandle);

    if (!did) {
      res
        .status(404)
        .json({ error: `Could not resolve handle: ${cleanHandle}` });
      return;
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
        inviterUserId: req.session.userId!,
        inviteeDid: did,
        inviteeHandle: cleanHandle,
      })
      .returning();

    logAudit({
      tenantId,
      actorUserId: req.session.userId!,
      action: "invitation_created",
      targetType: "invitation",
      targetId: invitation.id,
      metadata: { handle: cleanHandle, did },
    });

    res.status(201).json(invitation);
  },
);

invitationsRouter.get("/api/invitations", requireAuth, async (req, res) => {
  const did = req.session.did!;

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
      and(eq(invitations.inviteeDid, did), eq(invitations.status, "pending")),
    )
    .limit(100);

  res.json(pendingInvitations);
});

invitationsRouter.post(
  "/api/invitations/:invitationId/accept",
  requireAuth,
  async (req, res) => {
    const invitationId = param(req, "invitationId");
    const did = req.session.did!;

    const [invitation] = await db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.id, invitationId),
          eq(invitations.inviteeDid, did),
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

    if (!tenant || !tenant.apiKey) {
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

    const hsUsername = user.handle
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase();

    try {
      const client = new HeadscaleApiClient(tenant.port, tenant.apiKey);
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
    const did = req.session.did!;

    const [invitation] = await db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.id, invitationId),
          eq(invitations.inviteeDid, did),
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
      actorUserId: req.session.userId!,
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

    const result = await getTenantForUser(tenantId, req.session.userId!);
    if (!result) {
      res.status(403).json({ error: "Not a member of this tenant" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "invite")) {
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
      actorUserId: req.session.userId!,
      action: "invitation_revoked",
      targetType: "invitation",
      targetId: invitationId,
    });

    res.json({ status: "revoked" });
  },
);
