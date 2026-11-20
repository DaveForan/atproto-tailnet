/**
 * @module routes/sharing
 * Friends and device shares between members of a tailnet (ADR-0036).
 *
 * Two members become friends when one asks and the other accepts. Only
 * friends can ask for access to each other's devices. A share exposes one
 * device of the *owner*, on chosen ports, to the *guest*'s devices, and is
 * active only once the side that did not start it accepts. Either side can
 * end it at any time. Operators have no access to these routes' data.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { and, eq, inArray, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, memberships, friendships, memberBlocks, deviceShares, type AccessPortSpec } from "../db/schema.js";
import { requireAuth, param, getTenantForUser, isLockedDown, authUserId } from "./helpers.js";
import { logAudit } from "./audit.js";
import { notifyUser } from "../notifications/service.js";
import { listUserDevices } from "../access/devices.js";
import { syncTenantAccess } from "../access/sync.js";
import { stepUpForSession } from "../auth/step-up.js";

export const sharingRouter = Router();

/** Pending friend requests a member may have sent at once. */
export const MAX_PENDING_FRIEND_REQUESTS = 20;
/** Shares waiting for an answer that a member may have started at once. */
export const MAX_PENDING_SHARES = 30;
/** Port entries in one share. */
export const MAX_SHARE_PORTS = 16;
/** Longest share lifetime that can be requested (one year). */
export const MAX_SHARE_HOURS = 24 * 365;

const nodeId = z.string().regex(/^[1-9]\d{0,15}$/);
const portSpec = z
  .object({
    proto: z.enum(["any", "tcp", "udp", "icmp"]).default("tcp"),
    first: z.number().int().min(0).max(65535),
    last: z.number().int().min(0).max(65535),
  })
  .refine((p) => p.first <= p.last, "first must not exceed last")
  .refine((p) => p.proto === "icmp" || p.first >= 1, "ports start at 1");
const ports = z.array(portSpec).min(1).max(MAX_SHARE_PORTS);

type Ctx = NonNullable<Awaited<ReturnType<typeof getTenantForUser>>>;

async function member(req: Request, res: Response): Promise<{ ctx: Ctx; userId: string } | null> {
  const userId = authUserId(req);
  const ctx = await getTenantForUser(param(req, "tenantId"), userId);
  if (!ctx) {
    res.status(404).json({ error: "Tenant not found" });
    return null;
  }
  // Sharing is a personal decision: an agent token cannot make it for the member
  if (req.agentToken) {
    res.status(403).json({ error: "Agent tokens cannot manage friends or shares" });
    return null;
  }
  return { ctx, userId };
}

function pair(tenantId: string, a: string, b: string) {
  return and(
    eq(friendships.tenantId, tenantId),
    or(
      and(eq(friendships.requesterId, a), eq(friendships.addresseeId, b)),
      and(eq(friendships.requesterId, b), eq(friendships.addresseeId, a)),
    ),
  );
}

/** True when `a` and `b` are accepted friends in the tailnet. */
export async function areFriends(tenantId: string, a: string, b: string): Promise<boolean> {
  const [row] = await db.select({ status: friendships.status }).from(friendships).where(pair(tenantId, a, b));
  return row?.status === "accepted";
}

async function isBlockedBy(tenantId: string, blockerId: string, blockedId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: memberBlocks.id })
    .from(memberBlocks)
    .where(
      and(eq(memberBlocks.tenantId, tenantId), eq(memberBlocks.blockerId, blockerId), eq(memberBlocks.blockedId, blockedId)),
    );
  return Boolean(row);
}

/** End every live share between two members (unfriend, block). Returns how many ended. */
async function endSharesBetween(tenantId: string, a: string, b: string): Promise<number> {
  const ended = await db
    .update(deviceShares)
    .set({ status: "ended", endedAt: new Date() })
    .where(
      and(
        eq(deviceShares.tenantId, tenantId),
        inArray(deviceShares.status, ["requested", "offered", "active"]),
        or(
          and(eq(deviceShares.ownerId, a), eq(deviceShares.guestId, b)),
          and(eq(deviceShares.ownerId, b), eq(deviceShares.guestId, a)),
        ),
      ),
    )
    .returning({ id: deviceShares.id });
  return ended.length;
}

async function handles(ids: string[]): Promise<Map<string, { handle: string; displayName: string | null }>> {
  const out = new Map<string, { handle: string; displayName: string | null }>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: users.id, handle: users.handle, displayName: users.displayName })
    .from(users)
    .where(inArray(users.id, [...new Set(ids)]));
  for (const r of rows) out.set(r.id, { handle: r.handle, displayName: r.displayName });
  return out;
}

// ── Friends ─────────────────────────────────────────────────────────────

sharingRouter.get("/api/tenants/:tenantId/friends", requireAuth, async (req, res) => {
  const m = await member(req, res);
  if (!m) return;
  const tenantId = m.ctx.tenant.id;
  const rows = await db
    .select()
    .from(friendships)
    .where(
      and(eq(friendships.tenantId, tenantId), or(eq(friendships.requesterId, m.userId), eq(friendships.addresseeId, m.userId))),
    )
    .limit(500);
  const blocks = await db
    .select()
    .from(memberBlocks)
    .where(and(eq(memberBlocks.tenantId, tenantId), eq(memberBlocks.blockerId, m.userId)));
  const who = await handles([...rows.flatMap((r) => [r.requesterId, r.addresseeId]), ...blocks.map((b) => b.blockedId)]);
  const view = (r: (typeof rows)[number]) => {
    const otherId = r.requesterId === m.userId ? r.addresseeId : r.requesterId;
    return { id: r.id, userId: otherId, ...who.get(otherId), since: r.respondedAt ?? r.createdAt };
  };
  res.json({
    friends: rows.filter((r) => r.status === "accepted").map(view),
    incoming: rows.filter((r) => r.status === "pending" && r.addresseeId === m.userId).map(view),
    outgoing: rows.filter((r) => r.status === "pending" && r.requesterId === m.userId).map(view),
    blocked: blocks.map((b) => ({ userId: b.blockedId, ...who.get(b.blockedId) })),
  });
});

/** Members of the tailnet the caller could send a friend request to. */
sharingRouter.get("/api/tenants/:tenantId/friends/candidates", requireAuth, async (req, res) => {
  const m = await member(req, res);
  if (!m) return;
  const rows = await db
    .select({ userId: users.id, handle: users.handle, displayName: users.displayName })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.tenantId, m.ctx.tenant.id))
    .orderBy(users.handle)
    .limit(200);
  res.json({ members: rows.filter((r) => r.userId !== m.userId) });
});

sharingRouter.post("/api/tenants/:tenantId/friends", requireAuth, async (req, res) => {
  const m = await member(req, res);
  if (!m) return;
  const tenantId = m.ctx.tenant.id;
  if (isLockedDown(m.ctx.tenant)) {
    res.status(403).json({ error: "Tenant is in lockdown mode" });
    return;
  }
  const parsed = z.object({ userId: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success || parsed.data.userId === m.userId) {
    res.status(400).json({ error: "userId of another member is required" });
    return;
  }
  const other = parsed.data.userId;
  const [otherMembership] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, other)));
  // A blocked requester gets the same answer as for a non-member
  if (!otherMembership || (await isBlockedBy(tenantId, other, m.userId))) {
    res.status(404).json({ error: "Member not found" });
    return;
  }
  if (await isBlockedBy(tenantId, m.userId, other)) {
    res.status(409).json({ error: "You blocked this member. Unblock them first" });
    return;
  }
  const [existing] = await db.select().from(friendships).where(pair(tenantId, m.userId, other));
  if (existing?.status === "accepted") {
    res.status(409).json({ error: "You are already friends" });
    return;
  }
  if (existing) {
    // The other member already asked: this is the acceptance
    if (existing.addresseeId === m.userId) {
      const accepted = await db
        .update(friendships)
        .set({ status: "accepted", respondedAt: new Date() })
        .where(and(eq(friendships.id, existing.id), eq(friendships.status, "pending")))
        .returning({ id: friendships.id });
      if (accepted.length === 0) {
        res.status(409).json({ error: "That friend request was withdrawn" });
        return;
      }
      notifyUser(tenantId, other, "friend_accepted", { title: "Friend request accepted", link: "/#sharing" });
      res.json({ id: existing.id, status: "accepted" });
      return;
    }
    res.status(409).json({ error: "You already sent a request to this member" });
    return;
  }
  const pending = await db
    .select({ id: friendships.id })
    .from(friendships)
    .where(and(eq(friendships.tenantId, tenantId), eq(friendships.requesterId, m.userId), eq(friendships.status, "pending")));
  if (pending.length >= MAX_PENDING_FRIEND_REQUESTS) {
    res.status(429).json({ error: "You have too many pending friend requests" });
    return;
  }
  const [row] = await db
    .insert(friendships)
    .values({ tenantId, requesterId: m.userId, addresseeId: other })
    .returning();
  notifyUser(tenantId, other, "friend_request", { title: "New friend request", link: "/#sharing" });
  res.status(201).json({ id: row.id, status: "pending" });
});

sharingRouter.post("/api/tenants/:tenantId/friends/:friendshipId/accept", requireAuth, async (req, res) => {
  const m = await member(req, res);
  if (!m) return;
  // A new friendship lets the two ask for each other's devices: not during lockdown
  if (isLockedDown(m.ctx.tenant)) {
    res.status(403).json({ error: "Tenant is in lockdown mode" });
    return;
  }
  const [row] = await db
    .select()
    .from(friendships)
    .where(and(eq(friendships.id, param(req, "friendshipId")), eq(friendships.tenantId, m.ctx.tenant.id)));
  if (!row || row.addresseeId !== m.userId || row.status !== "pending") {
    res.status(404).json({ error: "Friend request not found" });
    return;
  }
  // Only from pending: a request withdrawn meanwhile (row deleted) stays withdrawn
  const accepted = await db
    .update(friendships)
    .set({ status: "accepted", respondedAt: new Date() })
    .where(and(eq(friendships.id, row.id), eq(friendships.status, "pending")))
    .returning({ id: friendships.id });
  if (accepted.length === 0) {
    res.status(404).json({ error: "Friend request not found" });
    return;
  }
  notifyUser(m.ctx.tenant.id, row.requesterId, "friend_accepted", { title: "Friend request accepted", link: "/#sharing" });
  res.json({ id: row.id, status: "accepted" });
});

/** Decline a request, cancel one you sent, or end a friendship (and its shares). */
sharingRouter.delete("/api/tenants/:tenantId/friends/:friendshipId", requireAuth, async (req, res) => {
  const m = await member(req, res);
  if (!m) return;
  const tenantId = m.ctx.tenant.id;
  const [row] = await db
    .select()
    .from(friendships)
    .where(and(eq(friendships.id, param(req, "friendshipId")), eq(friendships.tenantId, tenantId)));
  if (!row || (row.requesterId !== m.userId && row.addresseeId !== m.userId)) {
    res.status(404).json({ error: "Friendship not found" });
    return;
  }
  const other = row.requesterId === m.userId ? row.addresseeId : row.requesterId;
  await db.delete(friendships).where(eq(friendships.id, row.id));
  const ended = await endSharesBetween(tenantId, m.userId, other);
  if (ended > 0) await syncTenantAccess(tenantId);
  if (row.status === "accepted") {
    notifyUser(tenantId, other, "friend_removed", { title: "A friend ended your friendship", body: "Shares between you ended.", link: "/#sharing" });
  }
  res.json({ status: "removed", sharesEnded: ended });
});

// ── Blocks ──────────────────────────────────────────────────────────────

sharingRouter.post("/api/tenants/:tenantId/blocks", requireAuth, async (req, res) => {
  const m = await member(req, res);
  if (!m) return;
  const tenantId = m.ctx.tenant.id;
  const parsed = z.object({ userId: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success || parsed.data.userId === m.userId) {
    res.status(400).json({ error: "userId of another member is required" });
    return;
  }
  const other = parsed.data.userId;
  await db.insert(memberBlocks).values({ tenantId, blockerId: m.userId, blockedId: other }).onConflictDoNothing();
  await db.delete(friendships).where(pair(tenantId, m.userId, other));
  const ended = await endSharesBetween(tenantId, m.userId, other);
  if (ended > 0) await syncTenantAccess(tenantId);
  res.json({ status: "blocked", sharesEnded: ended });
});

sharingRouter.delete("/api/tenants/:tenantId/blocks/:userId", requireAuth, async (req, res) => {
  const m = await member(req, res);
  if (!m) return;
  await db
    .delete(memberBlocks)
    .where(
      and(
        eq(memberBlocks.tenantId, m.ctx.tenant.id),
        eq(memberBlocks.blockerId, m.userId),
        eq(memberBlocks.blockedId, param(req, "userId")),
      ),
    );
  res.json({ status: "unblocked" });
});

// ── A friend's devices (names only, to ask for one) ─────────────────────

sharingRouter.get("/api/tenants/:tenantId/friends/:userId/devices", requireAuth, async (req, res) => {
  const m = await member(req, res);
  if (!m) return;
  const other = param(req, "userId");
  if (!(await areFriends(m.ctx.tenant.id, m.userId, other))) {
    res.status(404).json({ error: "Friend not found" });
    return;
  }
  const devices = await listUserDevices(m.ctx.tenant, other).catch(() => []);
  // Names only: addresses appear once a share is active
  res.json({ devices: devices.map((d) => ({ id: d.id, name: d.name })) });
});

// ── Shares ──────────────────────────────────────────────────────────────

sharingRouter.get("/api/tenants/:tenantId/shares", requireAuth, async (req, res) => {
  const m = await member(req, res);
  if (!m) return;
  const rows = await db
    .select()
    .from(deviceShares)
    .where(
      and(
        eq(deviceShares.tenantId, m.ctx.tenant.id),
        inArray(deviceShares.status, ["requested", "offered", "active"]),
        or(eq(deviceShares.ownerId, m.userId), eq(deviceShares.guestId, m.userId)),
      ),
    )
    .limit(500);
  const who = await handles(rows.flatMap((r) => [r.ownerId, r.guestId]));
  const mine = await listUserDevices(m.ctx.tenant, m.userId).catch(() => []);
  const myDevice = new Map(mine.map((d) => [d.id, d]));
  const now = Date.now();
  res.json({
    shares: rows.map((r) => {
      const iAmOwner = r.ownerId === m.userId;
      const expired = r.expiresAt ? r.expiresAt.getTime() <= now : false;
      return {
        id: r.id,
        role: iAmOwner ? "owner" : "guest",
        other: { userId: iAmOwner ? r.guestId : r.ownerId, ...who.get(iAmOwner ? r.guestId : r.ownerId) },
        ownerNodeId: r.ownerNodeId,
        ownerDeviceName: iAmOwner ? (myDevice.get(r.ownerNodeId)?.name ?? null) : null,
        // The address is shown to the guest only while the share is active
        address: !iAmOwner || r.status !== "active" ? null : (myDevice.get(r.ownerNodeId)?.address ?? null),
        ports: r.ports,
        guestNodeIds: r.guestNodeIds,
        status: expired && r.status === "active" ? "expired" : r.status,
        // Who has to answer: the owner answers a request, the guest an offer
        awaitingMe: (r.status === "requested" && iAmOwner) || (r.status === "offered" && !iAmOwner),
        expiresAt: r.expiresAt,
        createdAt: r.createdAt,
      };
    }),
  });
});

const shareBody = z.object({
  kind: z.enum(["request", "offer"]),
  friendId: z.string().uuid(),
  ownerNodeId: nodeId,
  ports,
  guestNodeIds: z.array(nodeId).max(32).default([]),
  expiresInHours: z.number().int().min(1).max(MAX_SHARE_HOURS).optional(),
});

/**
 * Start a share. `request`: the caller is the guest and asks for a friend's
 * device. `offer`: the caller is the owner and offers one of their devices.
 * Nothing is opened until the other side accepts.
 */
sharingRouter.post("/api/tenants/:tenantId/shares", requireAuth, stepUpForSession, async (req, res) => {
  const m = await member(req, res);
  if (!m) return;
  const tenantId = m.ctx.tenant.id;
  if (isLockedDown(m.ctx.tenant)) {
    res.status(403).json({ error: "Tenant is in lockdown mode" });
    return;
  }
  const parsed = shareBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
    return;
  }
  const d = parsed.data;
  if (d.friendId === m.userId || !(await areFriends(tenantId, m.userId, d.friendId))) {
    res.status(403).json({ error: "You can only share with a friend", code: "not_friends" });
    return;
  }
  const ownerId = d.kind === "offer" ? m.userId : d.friendId;
  const guestId = d.kind === "offer" ? d.friendId : m.userId;

  const ownerDevices = await listUserDevices(m.ctx.tenant, ownerId).catch(() => null);
  if (!ownerDevices?.some((dev) => dev.id === d.ownerNodeId)) {
    res.status(400).json({ error: "That device does not belong to the member who would expose it" });
    return;
  }
  // The side that starts the share can only name its own devices as guest devices
  if (d.guestNodeIds.length > 0) {
    if (d.kind === "offer") {
      res.status(400).json({ error: "The guest chooses their own devices when they accept" });
      return;
    }
    const mine = await listUserDevices(m.ctx.tenant, m.userId).catch(() => null);
    const owned = new Set(mine?.map((dev) => dev.id));
    if (!d.guestNodeIds.every((id) => owned.has(id))) {
      res.status(400).json({ error: "You can only connect your own devices" });
      return;
    }
  }
  const status = d.kind === "offer" ? "offered" : "requested";
  const mineOpen = await db
    .select({ id: deviceShares.id })
    .from(deviceShares)
    .where(
      and(
        eq(deviceShares.tenantId, tenantId),
        eq(deviceShares.status, status),
        eq(d.kind === "offer" ? deviceShares.ownerId : deviceShares.guestId, m.userId),
      ),
    );
  if (mineOpen.length >= MAX_PENDING_SHARES) {
    res.status(429).json({ error: "You have too many shares waiting for an answer" });
    return;
  }
  const [row] = await db
    .insert(deviceShares)
    .values({
      tenantId,
      ownerId,
      guestId,
      ownerNodeId: d.ownerNodeId,
      ports: d.ports as AccessPortSpec[],
      guestNodeIds: [...new Set(d.guestNodeIds)],
      status,
      expiresAt: d.expiresInHours ? new Date(Date.now() + d.expiresInHours * 3600_000) : null,
    })
    .returning();
  notifyUser(tenantId, d.friendId, d.kind === "offer" ? "share_offered" : "share_requested", {
    title: d.kind === "offer" ? "A friend offers you access to a device" : "A friend asks for access to one of your devices",
    link: "/#sharing",
  });
  res.status(201).json({ id: row.id, status: row.status });
});

const acceptBody = z.object({
  /** Owner accepting a request may narrow the ports. */
  ports: ports.optional(),
  /** Guest accepting an offer may limit it to some of their devices. */
  guestNodeIds: z.array(nodeId).max(32).optional(),
});

/** True when every range of `narrow` lies inside a range of `wide` with a compatible protocol. */
export function portsWithin(narrow: AccessPortSpec[], wide: AccessPortSpec[]): boolean {
  return narrow.every((n) =>
    wide.some((w) => (w.proto === "any" || w.proto === n.proto) && (w.proto === "icmp" || (w.first <= n.first && n.last <= w.last))),
  );
}

sharingRouter.post("/api/tenants/:tenantId/shares/:shareId/accept", requireAuth, stepUpForSession, async (req, res) => {
  const m = await member(req, res);
  if (!m) return;
  const tenantId = m.ctx.tenant.id;
  if (isLockedDown(m.ctx.tenant)) {
    res.status(403).json({ error: "Tenant is in lockdown mode" });
    return;
  }
  const [share] = await db
    .select()
    .from(deviceShares)
    .where(and(eq(deviceShares.id, param(req, "shareId")), eq(deviceShares.tenantId, tenantId)));
  const ownerAnswers = share?.status === "requested" && share.ownerId === m.userId;
  const guestAnswers = share?.status === "offered" && share.guestId === m.userId;
  if (!share || (!ownerAnswers && !guestAnswers)) {
    res.status(404).json({ error: "Share not found" });
    return;
  }
  const parsed = acceptBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
    return;
  }
  if (!(await areFriends(tenantId, share.ownerId, share.guestId))) {
    await db.update(deviceShares).set({ status: "ended", endedAt: new Date() }).where(eq(deviceShares.id, share.id));
    res.status(409).json({ error: "You are no longer friends" });
    return;
  }

  if (ownerAnswers) {
    // The device must still be the owner's
    const mine = await listUserDevices(m.ctx.tenant, m.userId).catch(() => null);
    if (!mine?.some((dev) => dev.id === share.ownerNodeId)) {
      res.status(409).json({ error: "That device is no longer one of your devices" });
      return;
    }
    const narrowed = parsed.data.ports as AccessPortSpec[] | undefined;
    if (narrowed && !portsWithin(narrowed, share.ports)) {
      res.status(400).json({ error: "You can narrow the requested ports, not add to them" });
      return;
    }
    const changed = narrowed && JSON.stringify(narrowed) !== JSON.stringify(share.ports);
    if (changed) {
      // The guest sees the final scope before anything opens
      const moved = await db
        .update(deviceShares)
        .set({ ports: narrowed, status: "offered" })
        .where(and(eq(deviceShares.id, share.id), eq(deviceShares.status, share.status)))
        .returning({ id: deviceShares.id });
      if (moved.length === 0) {
        res.status(409).json({ error: "This share changed meanwhile; reload and try again" });
        return;
      }
      notifyUser(tenantId, share.guestId, "share_offered", {
        title: "A friend answered your request with fewer ports",
        link: "/#sharing",
      });
      res.json({ id: share.id, status: "offered" });
      return;
    }
  } else if (parsed.data.guestNodeIds) {
    const mine = await listUserDevices(m.ctx.tenant, m.userId).catch(() => null);
    const owned = new Set(mine?.map((dev) => dev.id));
    if (!parsed.data.guestNodeIds.every((id) => owned.has(id))) {
      res.status(400).json({ error: "You can only connect your own devices" });
      return;
    }
  }

  // Only from the state that was answered: a share or friendship ended
  // meanwhile (status "ended") must not come back to life
  const activated = await db
    .update(deviceShares)
    .set({
      status: "active",
      acceptedAt: new Date(),
      ...(guestAnswers && parsed.data.guestNodeIds ? { guestNodeIds: [...new Set(parsed.data.guestNodeIds)] } : {}),
    })
    .where(and(eq(deviceShares.id, share.id), eq(deviceShares.status, share.status)))
    .returning({ id: deviceShares.id });
  if (activated.length === 0) {
    res.status(409).json({ error: "This share was ended or changed meanwhile" });
    return;
  }
  const applied = await syncTenantAccess(tenantId);
  // Operators see that a share started, never its scope
  logAudit({
    tenantId,
    actorUserId: m.userId,
    action: "tenant_settings_updated",
    targetType: "tenant",
    targetId: tenantId,
    metadata: { operation: "device_share_started", shareId: share.id },
  });
  notifyUser(tenantId, ownerAnswers ? share.guestId : share.ownerId, "share_active", {
    title: "A device share is now active",
    link: "/#sharing",
  });
  res.json({ id: share.id, status: "active", applied });
});

/** Decline, cancel or end a share. Either side, at any time; access ends at once. */
sharingRouter.delete("/api/tenants/:tenantId/shares/:shareId", requireAuth, async (req, res) => {
  const m = await member(req, res);
  if (!m) return;
  const tenantId = m.ctx.tenant.id;
  const [share] = await db
    .select()
    .from(deviceShares)
    .where(and(eq(deviceShares.id, param(req, "shareId")), eq(deviceShares.tenantId, tenantId)));
  if (!share || share.status === "ended" || (share.ownerId !== m.userId && share.guestId !== m.userId)) {
    res.status(404).json({ error: "Share not found" });
    return;
  }
  await db.update(deviceShares).set({ status: "ended", endedAt: new Date() }).where(eq(deviceShares.id, share.id));
  const wasActive = share.status === "active";
  if (wasActive) {
    await syncTenantAccess(tenantId);
    logAudit({
      tenantId,
      actorUserId: m.userId,
      action: "tenant_settings_updated",
      targetType: "tenant",
      targetId: tenantId,
      metadata: { operation: "device_share_ended", shareId: share.id },
    });
  }
  notifyUser(tenantId, share.ownerId === m.userId ? share.guestId : share.ownerId, "share_ended", {
    title: wasActive ? "A device share ended" : "A device share was declined",
    link: "/#sharing",
  });
  res.json({ status: "ended" });
});

/** Stop all sharing of one of the caller's devices. */
sharingRouter.delete("/api/tenants/:tenantId/my-devices/:nodeId/shares", requireAuth, async (req, res) => {
  const m = await member(req, res);
  if (!m) return;
  const tenantId = m.ctx.tenant.id;
  const ended = await db
    .update(deviceShares)
    .set({ status: "ended", endedAt: new Date() })
    .where(
      and(
        eq(deviceShares.tenantId, tenantId),
        eq(deviceShares.ownerId, m.userId),
        eq(deviceShares.ownerNodeId, param(req, "nodeId")),
        inArray(deviceShares.status, ["requested", "offered", "active"]),
      ),
    )
    .returning({ id: deviceShares.id });
  if (ended.length > 0) await syncTenantAccess(tenantId);
  res.json({ sharesEnded: ended.length });
});
