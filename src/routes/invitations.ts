/**
 * @module routes/invitations
 * Invitation lifecycle: create (resolve handle via DNS/HTTP/Bluesky API),
 * list sent, list received, accept (provisions Headscale user + membership),
 * decline, and revoke. Gated by the "invite" permission and lockdown mode.
 */

import { Router } from "express";
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
  isLockedDown,
  authUserId,
  authUserDid,
} from "./helpers.js";
import { tenantGuard } from "./guard.js";
import { logAudit } from "../audit/log.js";
import { enforceMemberLimit } from "./limits.js";
import {
  ACCOUNT_DID_RE,
  normalizeAccountDid,
  resolveDidToHandle,
  resolveHandleToDid,
} from "../identity/handles.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Router for invitation CRUD: create, list, accept, decline, and revoke. */
export const invitationsRouter = Router();

invitationsRouter.get(
  "/api/tenants/:tenantId/invitations",
  requireAuth,
  tenantGuard({ permission: "invite" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");

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

/** Copyable link the inviter sends to the invitee. */
export function inviteUrl(invitationId: string): string {
  return `${config.publicUrl.replace(/\/+$/, "")}/invite/${invitationId}`;
}

invitationsRouter.post(
  "/api/tenants/:tenantId/invitations",
  requireAuth,
  tenantGuard({ permission: "invite", permissionError: "You do not have permission to invite", notLockedDown: true }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");

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
  tenantGuard({ permission: "invite", permissionError: "You do not have permission to revoke invitations" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const invitationId = param(req, "invitationId");

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
