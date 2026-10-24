import { Router } from "express";
import { resolveTxt } from "node:dns/promises";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  users,
  tenants,
  memberships,
  invitations,
} from "../db/schema.js";
import { HeadscaleApiClient } from "../orchestrator/headscale-api.js";
import { requireAuth, param } from "./helpers.js";

export const invitationsRouter = Router();

const HANDLE_RE =
  /^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

async function resolveHandleToDid(handle: string): Promise<string | null> {
  const cleanHandle = handle.replace(/^@/, "");

  if (!HANDLE_RE.test(cleanHandle)) {
    return null;
  }

  // Try DNS TXT _atproto.<handle>
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

  // Fallback: HTTP GET https://<handle>/.well-known/atproto-did
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

  // Try via public Bluesky API
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

// Create invitation — owner invites someone by handle
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

    // Verify caller is owner of this tenant
    const [membership] = await db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.userId, req.session.userId!),
          eq(memberships.role, "owner"),
        ),
      );

    if (!membership) {
      res.status(403).json({ error: "Only the tenant owner can invite" });
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

    // Check if already a member
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

    // Check for existing pending invitation
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

    res.status(201).json(invitation);
  },
);

// List invitations for the current user (pending ones they can accept)
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
    );

  res.json(pendingInvitations);
});

// Accept invitation
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

    // Get the tenant
    const [tenant] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, invitation.tenantId));

    if (!tenant || !tenant.apiKey) {
      res.status(500).json({ error: "Tenant instance not available" });
      return;
    }

    // Create user in Headscale instance via REST API
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

    // Create membership
    await db.insert(memberships).values({
      userId: user.id,
      tenantId: tenant.id,
      role: "member",
    });

    // Update invitation status
    await db
      .update(invitations)
      .set({ status: "accepted", updatedAt: new Date() })
      .where(eq(invitations.id, invitationId));

    res.json({ status: "accepted", tenantId: tenant.id });
  },
);

// Decline invitation
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

    res.json({ status: "declined" });
  },
);

// Revoke invitation (owner only)
invitationsRouter.delete(
  "/api/tenants/:tenantId/invitations/:invitationId",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const invitationId = param(req, "invitationId");

    const [membership] = await db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.userId, req.session.userId!),
          eq(memberships.role, "owner"),
        ),
      );

    if (!membership) {
      res.status(403).json({ error: "Only the tenant owner can revoke" });
      return;
    }

    await db
      .update(invitations)
      .set({ status: "revoked", updatedAt: new Date() })
      .where(eq(invitations.id, invitationId));

    res.json({ status: "revoked" });
  },
);
