/**
 * @module routes/boards
 * Boards of a tailnet (ADR-0036): controller board (public text), public board (approved
 * service posts that members connect to; needs `boardEnabled`) and private board (own services).
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants, users, servicePosts, serviceConnections, instanceSettings } from "../db/schema.js";
import {
  requireAuth,
  param,
  hasPermission,
  isLockedDown,
  authUserId,
} from "./helpers.js";
import { tenantGuard, tenantCtx } from "./guard.js";
import { logAudit } from "../audit/log.js";
import { httpsServicesAvailable } from "../orchestrator/gateway.js";
import { notify, notifyUser } from "../notifications/service.js";
import { listTenantDevices, listUserDevices } from "../access/devices.js";
import { syncTenantAccess } from "../access/sync.js";
import { validateHostname, tenantIdForPublicLink, primaryHostname } from "../orchestrator/hostnames.js";
import { lintBoardText, parseBoardText, renderBoardHtml } from "../shared/board-text.js";
import { config } from "../config.js";
import { useCoordinator } from "../orchestrator/control-client.js";
import { parseBody } from "./validation.js";

export const boardsRouter = Router({ caseSensitive: true });

/** Posts a member may have that are not removed (public + private). */
export const MAX_POSTS_PER_MEMBER = 50;
/** Devices one member may connect to one post. */
export const MAX_CONNECTED_DEVICES = 32;

const postBody = z.object({
  board: z.enum(["public", "private"]),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  nodeId: z.string().regex(/^[1-9]\d{0,15}$/),
  port: z.number().int().min(1).max(65535),
  proto: z.enum(["tcp", "udp"]).default("tcp"),
  name: z.string().optional(),
  /** Serve the name as an HTTPS web address through the gateway (ADR-0030). */
  web: z.boolean().optional(),
});

// Zod 4 applies inner defaults through .partial(). Proto drops its default so an absent proto stays absent.
const postPatch = postBody
  .omit({ board: true })
  .partial()
  .extend({ proto: z.enum(["tcp", "udp"]).optional() });

type Post = typeof servicePosts.$inferSelect;

/**
 * Why a post cannot be a web service, or null. A web service needs a name
 * (it is the address), TCP, and a coordinator that runs the gateway. The
 * gateway is only asked for when the post becomes a web service.
 */
async function webServiceProblem(
  name: string | null | undefined,
  proto: string,
  checkGateway = true,
): Promise<{ status: number; error: string; code: string } | null> {
  if (!name) return { status: 400, error: "A web address needs a name", code: "web_needs_name" };
  if (proto !== "tcp") return { status: 400, error: "A web address needs TCP", code: "web_needs_tcp" };
  if (checkGateway && !(await httpsServicesAvailable())) {
    return { status: 409, error: "This instance does not serve web addresses", code: "web_unavailable" };
  }
  return null;
}

/** Answer when the tailnet's public board is turned off; sent and true, or false. */
function refuseBoardOff(tenant: { boardEnabled: boolean }, res: Response): boolean {
  if (tenant.boardEnabled) return false;
  res.status(403).json({ error: "The public board is turned off in this tailnet", code: "board_disabled" });
  return true;
}

/** Reviewing public posts needs approve_services. */
const reviewGuard = tenantGuard({ permission: "approve_services" });

/** Validated service name, null when none was given, or an error message. */
function serviceName(raw: string | undefined, required: boolean): { name: string | null } | { error: string } {
  if (raw === undefined || raw.trim() === "") {
    return required ? { error: "A private service needs a name" } : { name: null };
  }
  const v = validateHostname(raw);
  if (!v.ok) {
    return { error: v.error === "reserved" ? "That name is reserved" : "Use lowercase letters, digits and single hyphens (1-63 characters)" };
  }
  return { name: v.name };
}

/** Service names share the namespace of tailnet addresses (ADR-0026). */
async function nameIsTailnetAddress(name: string | null): Promise<boolean> {
  return name !== null && (await tenantIdForPublicLink(name)) !== null;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "23505";
}

async function loadPost(tenantId: string, postId: string): Promise<Post | null> {
  const [post] = await db
    .select()
    .from(servicePosts)
    .where(and(eq(servicePosts.id, postId), eq(servicePosts.tenantId, tenantId)));
  return post && post.status !== "removed" ? post : null;
}


boardsRouter.get("/api/tenants/:tenantId/my-devices", requireAuth, tenantGuard(), async (req, res) => {
  const result = tenantCtx(res);
  try {
    res.json({ devices: await listUserDevices(result.tenant, authUserId(req)), supported: useCoordinator });
  } catch {
    res.status(502).json({ error: "Could not list devices" });
  }
});


boardsRouter.get("/api/tenants/:tenantId/boards/public", requireAuth, tenantGuard(), async (req, res) => {
  const userId = authUserId(req);
  const result = tenantCtx(res);
  const posts = await db
    .select({ post: servicePosts, authorHandle: users.handle, authorName: users.displayName })
    .from(servicePosts)
    .innerJoin(users, eq(servicePosts.authorId, users.id))
    .where(
      and(eq(servicePosts.tenantId, result.tenant.id), eq(servicePosts.board, "public"), eq(servicePosts.status, "approved")),
    )
    .orderBy(desc(servicePosts.createdAt))
    .limit(200);

  const ids = posts.map((p) => p.post.id);
  const connections = ids.length
    ? await db.select().from(serviceConnections).where(inArray(serviceConnections.postId, ids))
    : [];
  const devices = await listTenantDevices(result.tenant).catch(() => []);
  const deviceById = new Map(devices.map((d) => [d.id, d]));

  res.json({
    posts: posts.map(({ post, authorHandle, authorName }) => {
      const mine = connections.filter((c) => c.postId === post.id && c.userId === userId).map((c) => c.nodeId);
      const isAuthor = post.authorId === userId;
      const device = deviceById.get(post.nodeId);
      return {
        id: post.id,
        title: post.title,
        description: post.description,
        name: post.name,
        proto: post.proto,
        port: post.port,
        web: post.web,
        author: { handle: authorHandle, displayName: authorName },
        isAuthor,
        // The address is useful only once a device of the viewer is connected
        address: mine.length > 0 || isAuthor ? (device?.address ?? null) : null,
        // The web address works on the author's devices and on connected devices
        url: post.web && post.name && (mine.length > 0 || isAuthor) ? `https://${post.name}.${config.baseDomain}` : null,
        deviceOnline: device?.online ?? false,
        myConnectedDevices: mine,
        connectedDevices: isAuthor ? connections.filter((c) => c.postId === post.id).length : undefined,
        createdAt: post.createdAt,
      };
    }),
  });
});

/** The caller's own posts on both boards, any status except removed. */
boardsRouter.get("/api/tenants/:tenantId/boards/mine", requireAuth, tenantGuard(), async (req, res) => {
  const userId = authUserId(req);
  const result = tenantCtx(res);
  const posts = await db
    .select()
    .from(servicePosts)
    .where(
      and(eq(servicePosts.tenantId, result.tenant.id), eq(servicePosts.authorId, userId), ne(servicePosts.status, "removed")),
    )
    .orderBy(desc(servicePosts.createdAt))
    .limit(200);
  const ids = posts.filter((p) => p.board === "public").map((p) => p.id);
  const connections = ids.length
    ? await db
        .select({ c: serviceConnections, handle: users.handle })
        .from(serviceConnections)
        .innerJoin(users, eq(serviceConnections.userId, users.id))
        .where(inArray(serviceConnections.postId, ids))
    : [];
  const devices = await listUserDevices(result.tenant, userId).catch(() => []);
  const deviceById = new Map(devices.map((d) => [d.id, d]));
  res.json({
    baseDomain: config.baseDomain,
    // The form offers "web address" only when the gateway can serve it
    httpsServices: await httpsServicesAvailable(),
    posts: posts.map((p) => ({
      ...p,
      device: deviceById.get(p.nodeId) ?? null,
      connections:
        p.board === "public"
          ? Object.entries(
              connections
                .filter((c) => c.c.postId === p.id)
                .reduce<Record<string, { handle: string; devices: number }>>((acc, c) => {
                  acc[c.c.userId] = { handle: c.handle, devices: (acc[c.c.userId]?.devices ?? 0) + 1 };
                  return acc;
                }, {}),
            ).map(([userId, v]) => ({ userId, ...v }))
          : undefined,
    })),
  });
});

/** Posts waiting for review (operators of the tailnet). */
boardsRouter.get("/api/tenants/:tenantId/boards/pending", requireAuth, reviewGuard, async (req, res) => {
  const result = tenantCtx(res);
  const posts = await db
    .select({ post: servicePosts, authorHandle: users.handle })
    .from(servicePosts)
    .innerJoin(users, eq(servicePosts.authorId, users.id))
    .where(
      and(eq(servicePosts.tenantId, result.tenant.id), eq(servicePosts.board, "public"), eq(servicePosts.status, "pending")),
    )
    .orderBy(servicePosts.createdAt)
    .limit(200);
  res.json({ posts: posts.map(({ post, authorHandle }) => ({ ...post, authorHandle })) });
});


boardsRouter.post("/api/tenants/:tenantId/boards/posts", requireAuth, tenantGuard({ notLockedDown: true }), async (req, res) => {
  const userId = authUserId(req);
  const result = tenantCtx(res);
  const parsed = parseBody(postBody, req, res);
  if (!parsed) return;
  const data = parsed.data;
  if (data.board === "public") {
    if (refuseBoardOff(result.tenant, res)) return;
    if (!hasPermission(result.membership, result.role, "create_posts", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
  }
  const named = serviceName(data.name, data.board === "private");
  if ("error" in named) {
    res.status(400).json({ error: named.error });
    return;
  }

  if (await nameIsTailnetAddress(named.name)) {
    res.status(409).json({ error: "That service name is already in use" });
    return;
  }
  const webProblem = data.web ? await webServiceProblem(named.name, data.proto) : null;
  if (webProblem) {
    res.status(webProblem.status).json({ error: webProblem.error, code: webProblem.code });
    return;
  }

  // A post is always on a device of its author
  const devices = await listUserDevices(result.tenant, userId).catch(() => null);
  if (!devices) {
    res.status(502).json({ error: "Could not list your devices" });
    return;
  }
  if (!devices.some((d) => d.id === data.nodeId)) {
    res.status(400).json({ error: "That device is not one of your devices in this tailnet" });
    return;
  }

  const existing = await db
    .select({ id: servicePosts.id })
    .from(servicePosts)
    .where(
      and(eq(servicePosts.tenantId, result.tenant.id), eq(servicePosts.authorId, userId), ne(servicePosts.status, "removed")),
    );
  if (existing.length >= MAX_POSTS_PER_MEMBER) {
    res.status(409).json({ error: `You can have at most ${MAX_POSTS_PER_MEMBER} service posts` });
    return;
  }

  // Private posts and the originator's own posts need no review
  const approved = data.board === "private" || result.membership.isOriginator;
  try {
    const [post] = await db
      .insert(servicePosts)
      .values({
        tenantId: result.tenant.id,
        authorId: userId,
        board: data.board,
        title: data.title,
        description: data.description ?? null,
        name: named.name,
        nodeId: data.nodeId,
        proto: data.proto,
        port: data.port,
        web: data.web ?? false,
        status: approved ? "approved" : "pending",
        reviewedById: approved && data.board === "public" ? userId : null,
        reviewedAt: approved && data.board === "public" ? new Date() : null,
      })
      .returning();

    if (data.board === "public") {
      logAudit({
        tenantId: result.tenant.id,
        actorUserId: userId,
        action: "tenant_settings_updated",
        targetType: "tenant",
        targetId: result.tenant.id,
        metadata: { operation: "service_post_created", postId: post.id, port: post.port, proto: post.proto, approved },
      });
      if (!approved) {
        notify(result.tenant.id, "service_approval_requested", {
          title: "Service post needs review",
          body: `"${post.title}" (port ${post.port}) is waiting for approval.`,
          link: "/#board",
        });
      }
    }
    if (post.name) await syncTenantAccess(result.tenant.id);
    res.status(201).json(post);
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: "That service name is already in use" });
      return;
    }
    throw err;
  }
});

boardsRouter.patch("/api/tenants/:tenantId/boards/posts/:postId", requireAuth, tenantGuard(), async (req, res) => {
  const userId = authUserId(req);
  const result = tenantCtx(res);
  const post = await loadPost(result.tenant.id, param(req, "postId"));
  if (!post || post.authorId !== userId) {
    res.status(404).json({ error: "Post not found" });
    return;
  }
  if (isLockedDown(result.tenant)) {
    res.status(403).json({ error: "Tenant is in lockdown mode" });
    return;
  }
  if (post.board === "public" && refuseBoardOff(result.tenant, res)) return;
  const parsed = parseBody(postPatch, req, res);
  if (!parsed) return;
  const data = parsed.data;
  const updates: Partial<Post> = { updatedAt: new Date() };
  if (data.title !== undefined) updates.title = data.title;
  if (data.description !== undefined) updates.description = data.description || null;
  if (data.name !== undefined) {
    const named = serviceName(data.name, post.board === "private");
    if ("error" in named) {
      res.status(400).json({ error: named.error });
      return;
    }
    if (await nameIsTailnetAddress(named.name)) {
      res.status(409).json({ error: "That service name is already in use" });
      return;
    }
    updates.name = named.name;
  }
  if (data.nodeId !== undefined && data.nodeId !== post.nodeId) {
    const devices = await listUserDevices(result.tenant, userId).catch(() => null);
    if (!devices?.some((d) => d.id === data.nodeId)) {
      res.status(400).json({ error: "That device is not one of your devices in this tailnet" });
      return;
    }
    updates.nodeId = data.nodeId;
  }
  if (data.port !== undefined) updates.port = data.port;
  if (data.proto !== undefined) updates.proto = data.proto;
  if (data.web !== undefined) updates.web = data.web;
  // The rules of a web service hold for the post as it will be after this change
  if (updates.web ?? post.web) {
    const webProblem = await webServiceProblem(
      updates.name !== undefined ? updates.name : post.name,
      updates.proto ?? post.proto,
      !post.web,
    );
    if (webProblem) {
      res.status(webProblem.status).json({ error: webProblem.error, code: webProblem.code });
      return;
    }
  }

  // What the post opens changed: an approval of the old target does not
  // cover the new one, and connected devices must not follow it silently.
  const targetChanged =
    (updates.nodeId !== undefined && updates.nodeId !== post.nodeId) ||
    (updates.port !== undefined && updates.port !== post.port) ||
    (updates.proto !== undefined && updates.proto !== post.proto);
  // A new public name is what members see and resolve: it needs a new approval
  // too (connections stay; they follow the same device and port)
  const renamed = updates.name !== undefined && updates.name !== post.name;
  if (targetChanged && post.board === "public") {
    await db.delete(serviceConnections).where(eq(serviceConnections.postId, post.id));
  }
  if ((targetChanged || renamed) && post.board === "public" && !result.membership.isOriginator && post.status !== "pending") {
    updates.status = "pending";
    updates.reviewedById = null;
    updates.reviewedAt = null;
    updates.rejectReason = null;
  }
  const backToReview = updates.status === "pending" && post.status !== "pending";

  try {
    const [updated] = await db.update(servicePosts).set(updates).where(eq(servicePosts.id, post.id)).returning();
    const namesChanged = updated.name !== post.name || (updated.name !== null && updated.nodeId !== post.nodeId);
    if ((targetChanged && post.board === "public") || namesChanged || backToReview) {
      await syncTenantAccess(result.tenant.id);
    }
    if (backToReview || (targetChanged && post.board === "public" && updated.status === "pending")) {
      notify(result.tenant.id, "service_approval_requested", {
        title: "Service post changed and needs review",
        body: targetChanged
          ? `"${updated.title}" now points at port ${updated.port}.`
          : `"${updated.title}" has a new name${updated.name ? `: ${updated.name}` : ""}.`,
        link: "/#board",
      });
    }
    res.json(updated);
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: "That service name is already in use" });
      return;
    }
    throw err;
  }
});

/** Remove a post: its author, or an operator with `manage_board`. Access ends at once. */
boardsRouter.delete("/api/tenants/:tenantId/boards/posts/:postId", requireAuth, tenantGuard(), async (req, res) => {
  const userId = authUserId(req);
  const result = tenantCtx(res);
  const post = await loadPost(result.tenant.id, param(req, "postId"));
  const isAuthor = post?.authorId === userId;
  // Operators manage the public board only; a private post is its owner's business
  const asOperator = post?.board === "public" && hasPermission(result.membership, result.role, "manage_board", req);
  if (!post || (!isAuthor && !asOperator)) {
    res.status(404).json({ error: "Post not found" });
    return;
  }
  await db.delete(serviceConnections).where(eq(serviceConnections.postId, post.id));
  await db.update(servicePosts).set({ status: "removed", updatedAt: new Date() }).where(eq(servicePosts.id, post.id));
  if (post.board === "public" || post.name) await syncTenantAccess(result.tenant.id);
  if (post.board === "public") {
    logAudit({
      tenantId: result.tenant.id,
      actorUserId: userId,
      action: "tenant_settings_updated",
      targetType: "tenant",
      targetId: result.tenant.id,
      metadata: { operation: "service_post_removed", postId: post.id, byOperator: !isAuthor },
    });
    if (!isAuthor) {
      notifyUser(result.tenant.id, post.authorId, "service_post_removed", {
        title: "Your service post was removed",
        body: `An operator removed "${post.title}".`,
        link: "/#board",
      });
    }
  }
  res.json({ status: "removed" });
});


/** Approve or reject a public post. Runs after {@link reviewGuard}. */
async function review(req: Request, res: Response, approve: boolean) {
  const userId = authUserId(req);
  const result = tenantCtx(res);
  const post = await loadPost(result.tenant.id, param(req, "postId"));
  if (!post || post.board !== "public") {
    res.status(404).json({ error: "Post not found" });
    return;
  }
  // Approval opens access to the post: not during lockdown (withdrawing is always allowed)
  if (approve && isLockedDown(result.tenant)) {
    res.status(403).json({ error: "Tenant is in lockdown mode" });
    return;
  }
  // Withdrawing an approval is allowed; approving needs a pending or rejected post
  if (approve && post.status === "approved") {
    res.status(409).json({ error: "Post is already approved" });
    return;
  }
  const reason = approve ? null : z.string().trim().max(500).safeParse((req.body ?? {}).reason).data || null;
  if (!approve) {
    await db.delete(serviceConnections).where(eq(serviceConnections.postId, post.id));
  }
  const [updated] = await db
    .update(servicePosts)
    .set({
      status: approve ? "approved" : "rejected",
      rejectReason: reason,
      reviewedById: userId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(servicePosts.id, post.id))
    .returning();
  // Approval makes a named service resolvable; rejection closes access
  if (!approve || post.name) await syncTenantAccess(result.tenant.id);
  logAudit({
    tenantId: result.tenant.id,
    actorUserId: userId,
    action: "tenant_settings_updated",
    targetType: "tenant",
    targetId: result.tenant.id,
    metadata: { operation: approve ? "service_post_approved" : "service_post_rejected", postId: post.id },
  });
  notifyUser(result.tenant.id, post.authorId, approve ? "service_post_approved" : "service_post_rejected", {
    title: approve ? "Your service post was approved" : "Your service post was not approved",
    body: approve ? `"${post.title}" is now on the public board.` : reason ? `"${post.title}": ${reason}` : `"${post.title}"`,
    link: "/#board",
  });
  res.json(updated);
}

boardsRouter.post("/api/tenants/:tenantId/boards/posts/:postId/approve", requireAuth, reviewGuard, (req, res) => review(req, res, true));
boardsRouter.post("/api/tenants/:tenantId/boards/posts/:postId/reject", requireAuth, reviewGuard, (req, res) => review(req, res, false));


/**
 * Set which of the caller's devices are connected to a post (an empty list
 * disconnects). Each connected device may reach the post's device on the
 * post's port, and nothing else.
 */
boardsRouter.put("/api/tenants/:tenantId/boards/posts/:postId/connections", requireAuth, tenantGuard(), async (req, res) => {
  const userId = authUserId(req);
  const result = tenantCtx(res);
  const post = await loadPost(result.tenant.id, param(req, "postId"));
  if (!post || post.board !== "public" || post.status !== "approved") {
    res.status(404).json({ error: "Post not found" });
    return;
  }
  const parsed = parseBody(
    z.object({ nodeIds: z.array(z.string().regex(/^[1-9]\d{0,15}$/)).max(MAX_CONNECTED_DEVICES) }),
    req,
    res,
  );
  if (!parsed) return;
  const wanted = [...new Set(parsed.data.nodeIds)];
  if (wanted.length > 0 && isLockedDown(result.tenant)) {
    res.status(403).json({ error: "Tenant is in lockdown mode" });
    return;
  }
  // Disconnecting stays possible: it only removes access.
  if (wanted.length > 0 && refuseBoardOff(result.tenant, res)) return;
  if (wanted.length > 0) {
    const mine = await listUserDevices(result.tenant, userId).catch(() => null);
    if (!mine) {
      res.status(502).json({ error: "Could not list your devices" });
      return;
    }
    const owned = new Set(mine.map((d) => d.id));
    if (!wanted.every((id) => owned.has(id))) {
      res.status(400).json({ error: "You can only connect your own devices" });
      return;
    }
  }
  await db
    .delete(serviceConnections)
    .where(and(eq(serviceConnections.postId, post.id), eq(serviceConnections.userId, userId)));
  if (wanted.length > 0) {
    await db.insert(serviceConnections).values(wanted.map((nodeId) => ({ postId: post.id, userId, nodeId })));
  }
  const synced = await syncTenantAccess(result.tenant.id);
  res.json({ connectedDevices: wanted, applied: synced });
});

/** The author removes one member's devices from their post. */
boardsRouter.delete("/api/tenants/:tenantId/boards/posts/:postId/connections/:userId", requireAuth, tenantGuard(), async (req, res) => {
  const userId = authUserId(req);
  const result = tenantCtx(res);
  const post = await loadPost(result.tenant.id, param(req, "postId"));
  if (!post || post.authorId !== userId) {
    res.status(404).json({ error: "Post not found" });
    return;
  }
  await db
    .delete(serviceConnections)
    .where(and(eq(serviceConnections.postId, post.id), eq(serviceConnections.userId, param(req, "userId"))));
  await syncTenantAccess(result.tenant.id);
  res.json({ status: "disconnected" });
});


boardsRouter.get("/api/tenants/:tenantId/access-mode", requireAuth, tenantGuard(), async (req, res) => {
  const result = tenantCtx(res);
  res.json({
    mode: result.tenant.accessMode === "member" ? "member" : "open",
    supported: useCoordinator,
    canEdit: hasPermission(result.membership, result.role, "manage_acl", req),
  });
});

/**
 * "member": a device reaches only its owner's devices, plus approved service
 * posts and shares between friends. "open": every device reaches every
 * device (or the ACL policy applies).
 */
boardsRouter.put("/api/tenants/:tenantId/access-mode", requireAuth, tenantGuard({ permission: "manage_acl" }), async (req, res) => {
  const userId = authUserId(req);
  const result = tenantCtx(res);
  const parsed = z.object({ mode: z.enum(["open", "member"]) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'mode must be "open" or "member"' });
    return;
  }
  if (parsed.data.mode === "member" && !useCoordinator) {
    res.status(409).json({ error: "Member mode needs the coordinator control plane", code: "coordinator_required" });
    return;
  }
  await db
    .update(tenants)
    .set({ accessMode: parsed.data.mode, updatedAt: new Date() })
    .where(eq(tenants.id, result.tenant.id));
  const applied = await syncTenantAccess(result.tenant.id);
  logAudit({
    tenantId: result.tenant.id,
    actorUserId: userId,
    action: "tenant_settings_updated",
    targetType: "tenant",
    targetId: result.tenant.id,
    metadata: { accessMode: parsed.data.mode },
  });
  res.json({ mode: parsed.data.mode, applied });
});


boardsRouter.get("/api/tenants/:tenantId/controller-board", requireAuth, tenantGuard(), async (req, res) => {
  const result = tenantCtx(res);
  res.json({
    text: result.tenant.controllerBoardText ?? "",
    canEdit: result.membership.isOriginator && !req.agentToken,
    address: await primaryHostname(result.tenant.id, result.tenant.slug),
  });
});

/** Only the originator writes the public page of the tailnet. */
boardsRouter.put("/api/tenants/:tenantId/controller-board", requireAuth, tenantGuard({ originatorOnly: "Only the tailnet's originator can edit the controller board", noAgentToken: "Only the tailnet's originator can edit the controller board" }), async (req, res) => {
  const userId = authUserId(req);
  const result = tenantCtx(res);
  const text = (req.body ?? {}).text;
  const problems = lintBoardText(text);
  if (problems.length > 0) {
    res.status(400).json({ error: problems[0], problems });
    return;
  }
  const trimmed = (text as string).trim();
  await db
    .update(tenants)
    .set({ controllerBoardText: trimmed || null, updatedAt: new Date() })
    .where(eq(tenants.id, result.tenant.id));
  logAudit({
    tenantId: result.tenant.id,
    actorUserId: userId,
    action: "tenant_settings_updated",
    targetType: "tenant",
    targetId: result.tenant.id,
    metadata: { operation: "controller_board_updated", length: trimmed.length },
  });
  res.json({ text: trimmed });
});

/** Public controller board of a live, non-suspended tailnet: name and rendered text only. */
export async function publicControllerBoard(
  tenantId: string | null,
): Promise<{ name: string; text: string; html: string } | null> {
  if (!tenantId) return null;
  const [t] = await db
    .select({ name: tenants.name, text: tenants.controllerBoardText, status: tenants.status, suspended: tenants.suspended })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!t || t.status === "deleted" || t.suspended) return null;
  const text = t.text ?? "";
  return { name: t.name, text, html: renderBoardHtml(parseBoardText(text)) };
}

/** Controller board by public tailnet address — no sign-in. */
boardsRouter.get("/api/public/board/:name", async (req, res) => {
  const board = await publicControllerBoard(await tenantIdForPublicLink(param(req, "name")));
  if (!board) {
    res.status(404).json({ error: "Board not found" });
    return;
  }
  res.json({ name: board.name, text: board.text });
});

/** Controller board of the instance's default tailnet, for the landing page. */
boardsRouter.get("/api/public/landing", async (_req, res) => {
  const [settings] = await db.select({ id: instanceSettings.defaultTailnetId }).from(instanceSettings).limit(1);
  const board = await publicControllerBoard(settings?.id ?? null);
  res.json({ name: board?.name ?? null, text: board?.text ?? "" });
});

const PAGE = (title: string, body: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} — atproto-tailnet</title>
  <link rel="stylesheet" href="/css/dashboard.css" />
</head>
<body>
  <main class="container controller-board">
    ${body}
    <p><a href="/">Sign in</a></p>
  </main>
</body>
</html>`;

const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** The controller board as a page. No script; the text is rendered by our own code. */
boardsRouter.get("/board/:name", async (req, res) => {
  const board = await publicControllerBoard(await tenantIdForPublicLink(param(req, "name")));
  if (!board) {
    res.status(404).type("text/plain").send("Board not found");
    return;
  }
  res.type("html").send(PAGE(escHtml(board.name), `<h1>${escHtml(board.name)}</h1>\n${board.html}`));
});
