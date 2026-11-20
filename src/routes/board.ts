/**
 * @module routes/board
 * Board post CRUD (create, list, soft-delete) and public board endpoints.
 * Posts are linked to active services and capped by tenant-level limits
 * (maxBoardPosts enforced transactionally). The public board API and
 * rendered HTML page at /board/:slug require no auth but respect
 * lockdown and boardEnabled settings.
 */

import { Router } from "express";
import { eq, and, desc, count, sql, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import {
  tenants,
  users,
  services,
  serviceDevices,
  boardPosts,
} from "../db/schema.js";
import {
  requireAuth,
  param,
  getTenantForUser,
  hasPermission,
  authUserId,
} from "./helpers.js";
import { logAudit } from "./audit.js";
import { tenantIdForPublicLink } from "../orchestrator/hostnames.js";

/**
 * Router for board post CRUD, public board JSON API, and the
 * server-rendered public board page at /board/:slug.
 */
export const boardRouter = Router();

// ── Board posts CRUD ───────────────────────────────────────────────

const postBody = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  serviceId: z.string().uuid(),
});

boardRouter.get(
  "/api/tenants/:tenantId/board-posts",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const rows = await db
      .select({
        id: boardPosts.id,
        title: boardPosts.title,
        description: boardPosts.description,
        status: boardPosts.status,
        serviceId: boardPosts.serviceId,
        serviceName: services.name,
        serviceUrl: services.url,
        authorHandle: users.handle,
        authorDisplayName: users.displayName,
        authorId: boardPosts.authorId,
        createdAt: boardPosts.createdAt,
      })
      .from(boardPosts)
      .innerJoin(users, eq(boardPosts.authorId, users.id))
      .innerJoin(services, eq(boardPosts.serviceId, services.id))
      .where(
        and(
          eq(boardPosts.tenantId, tenantId),
          eq(boardPosts.status, "active"),
        ),
      )
      .orderBy(desc(boardPosts.createdAt))
      .limit(200);

    res.json(rows);
  },
);

boardRouter.post(
  "/api/tenants/:tenantId/board-posts",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const userId = authUserId(req);

    const result = await getTenantForUser(tenantId, userId);
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "create_posts", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    if (!result.tenant.boardEnabled) {
      res.status(403).json({ error: "Board is not enabled" });
      return;
    }

    const parsed = postBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
      return;
    }

    const [service] = await db
      .select()
      .from(services)
      .where(
        and(
          eq(services.id, parsed.data.serviceId),
          eq(services.tenantId, tenantId),
          eq(services.status, "active"),
        ),
      );

    if (!service) {
      res.status(400).json({ error: "Active service not found" });
      return;
    }

    const created = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM ${tenants} WHERE ${tenants.id} = ${tenantId} FOR UPDATE`);

      const [{ total }] = await tx
        .select({ total: count() })
        .from(boardPosts)
        .where(
          and(
            eq(boardPosts.tenantId, tenantId),
            eq(boardPosts.status, "active"),
          ),
        );

      if (total >= result.tenant.maxBoardPosts) {
        return null;
      }

      const [row] = await tx
        .insert(boardPosts)
        .values({
          tenantId,
          authorId: userId,
          serviceId: parsed.data.serviceId,
          title: parsed.data.title,
          description: parsed.data.description ?? null,
        })
        .returning();
      return row;
    });

    if (!created) {
      res.status(409).json({ error: "Maximum number of board posts reached (" + result.tenant.maxBoardPosts + ")" });
      return;
    }

    logAudit({
      tenantId,
      actorUserId: userId,
      action: "board_post_created",
      targetType: "board_post",
      targetId: created.id,
      metadata: { title: parsed.data.title, serviceId: parsed.data.serviceId },
    });

    res.status(201).json(created);
  },
);

boardRouter.delete(
  "/api/tenants/:tenantId/board-posts/:postId",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const postId = param(req, "postId");

    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const [post] = await db
      .select()
      .from(boardPosts)
      .where(
        and(
          eq(boardPosts.id, postId),
          eq(boardPosts.tenantId, tenantId),
        ),
      );

    if (!post) {
      res.status(404).json({ error: "Post not found" });
      return;
    }

    const isAuthor = post.authorId === authUserId(req);
    const canRemoveOwn = isAuthor && hasPermission(result.membership, result.role, "create_posts", req);
    const canRemoveAny = hasPermission(result.membership, result.role, "manage_board", req);

    if (!canRemoveOwn && !canRemoveAny) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    await db
      .update(boardPosts)
      .set({ status: "removed", updatedAt: new Date() })
      .where(eq(boardPosts.id, postId));

    logAudit({
      tenantId,
      actorUserId: authUserId(req),
      action: "board_post_removed",
      targetType: "board_post",
      targetId: postId,
      metadata: { title: post.title },
    });

    res.json({ status: "removed" });
  },
);

// ── Public board page ──────────────────────────────────────────────

/**
 * The tenant behind a public board, or null when the board isn't publicly
 * visible: unknown slug, deleted or suspended tenant, lockdown, or board off.
 */
export async function findPublicBoardTenant(slug: string) {
  const [tenant] = await db
    .select({
      id: tenants.id,
      slug: tenants.slug,
      name: tenants.name,
      boardEnabled: tenants.boardEnabled,
      lockdownMode: tenants.lockdownMode,
      maxBoardPostsDisplayed: tenants.maxBoardPostsDisplayed,
    })
    .from(tenants)
    .where(
      and(
        eq(tenants.id, (await tenantIdForPublicLink(slug)) ?? "00000000-0000-0000-0000-000000000000"),
        ne(tenants.status, "deleted"),
        eq(tenants.suspended, false),
      ),
    );

  if (!tenant || tenant.lockdownMode || !tenant.boardEnabled) return null;
  return tenant;
}

boardRouter.get("/api/tenants/by-slug/:slug/board", async (req, res) => {
  const tenant = await findPublicBoardTenant(param(req, "slug"));
  if (!tenant) {
    res.status(404).json({ error: "Board not found" });
    return;
  }

  const posts = await db
    .select({
      id: boardPosts.id,
      title: boardPosts.title,
      description: boardPosts.description,
      serviceName: services.name,
      serviceDescription: services.description,
      serviceUrl: services.url,
      authorHandle: users.handle,
      authorDisplayName: users.displayName,
      createdAt: boardPosts.createdAt,
    })
    .from(boardPosts)
    .innerJoin(users, eq(boardPosts.authorId, users.id))
    .innerJoin(services, eq(boardPosts.serviceId, services.id))
    .where(
      and(
        eq(boardPosts.tenantId, tenant.id),
        eq(boardPosts.status, "active"),
        eq(services.status, "active"),
      ),
    )
    .orderBy(desc(boardPosts.createdAt))
    .limit(tenant.maxBoardPostsDisplayed);

  res.json({
    tenant: { name: tenant.name, slug: tenant.slug },
    posts,
  });
});

// Script and styles are static files (public/js/board.js from
// src/client/board.ts, public/css/board.css) so the page works under the
// global CSP (script-src 'self'; style-src 'self').
const BOARD_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Board — atproto-tailnet</title>
  <link rel="stylesheet" href="/css/board.css" />
</head>
<body>
  <div class="container">
    <div id="board-app">Loading...</div>
  </div>
  <script src="/js/board.js"></script>
</body>
</html>`;

boardRouter.get("/board/:slug", async (req, res) => {
  if (!(await findPublicBoardTenant(param(req, "slug")))) {
    res.status(404).type("text/plain").send("Board not found");
    return;
  }
  res.type("html").send(BOARD_PAGE_HTML);
});
