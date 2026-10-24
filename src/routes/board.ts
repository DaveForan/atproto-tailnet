import { Router } from "express";
import { eq, and, desc, count } from "drizzle-orm";
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
} from "./helpers.js";
import { logAudit } from "./audit.js";

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
    const result = await getTenantForUser(tenantId, req.session.userId!);
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
      .orderBy(desc(boardPosts.createdAt));

    res.json(rows);
  },
);

boardRouter.post(
  "/api/tenants/:tenantId/board-posts",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const userId = req.session.userId!;

    const result = await getTenantForUser(tenantId, userId);
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "create_posts")) {
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

    const [{ total }] = await db
      .select({ total: count() })
      .from(boardPosts)
      .where(
        and(
          eq(boardPosts.tenantId, tenantId),
          eq(boardPosts.status, "active"),
        ),
      );

    if (total >= result.tenant.maxBoardPosts) {
      res.status(409).json({ error: "Maximum number of board posts reached (" + result.tenant.maxBoardPosts + ")" });
      return;
    }

    const [created] = await db
      .insert(boardPosts)
      .values({
        tenantId,
        authorId: userId,
        serviceId: parsed.data.serviceId,
        title: parsed.data.title,
        description: parsed.data.description ?? null,
      })
      .returning();

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

    const result = await getTenantForUser(tenantId, req.session.userId!);
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

    const isAuthor = post.authorId === req.session.userId;
    const canRemoveOwn = isAuthor && hasPermission(result.membership, result.role, "create_posts");
    const canRemoveAny = hasPermission(result.membership, result.role, "manage_board");

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
      actorUserId: req.session.userId!,
      action: "board_post_removed",
      targetType: "board_post",
      targetId: postId,
      metadata: { title: post.title },
    });

    res.json({ status: "removed" });
  },
);

// ── Public board page ──────────────────────────────────────────────

boardRouter.get("/api/tenants/by-slug/:slug/board", async (req, res) => {
  const slug = param(req, "slug");

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
    .where(eq(tenants.slug, slug));

  if (!tenant || tenant.lockdownMode || !tenant.boardEnabled) {
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

const BOARD_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Board — atproto-tailnet</title>
  <style>
    :root {
      --bg: #0a0a0f;
      --surface: #13131a;
      --border: #23232f;
      --text: #e4e4ed;
      --text-dim: #8888a0;
      --accent: #6366f1;
      --accent-hover: #818cf8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      padding: 24px;
    }
    .container { max-width: 720px; margin: 0 auto; }
    h1 { font-size: 28px; font-weight: 600; margin-bottom: 4px; }
    .subtitle { color: var(--text-dim); font-size: 14px; margin-bottom: 32px; }
    .post-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 20px;
      margin-bottom: 16px;
      cursor: pointer;
      transition: border-color 0.15s;
    }
    .post-card:hover { border-color: var(--accent); }
    .post-title { font-size: 18px; font-weight: 600; margin-bottom: 4px; }
    .post-desc { color: var(--text-dim); font-size: 14px; margin-bottom: 12px; }
    .post-meta { display: flex; gap: 16px; font-size: 12px; color: var(--text-dim); }
    .service-tag {
      display: inline-block;
      background: var(--accent);
      color: white;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .empty { text-align: center; padding: 48px; color: var(--text-dim); }
    .back-link { display: block; margin-top: 24px; text-align: center; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div id="board-app">Loading...</div>
  </div>
  <script>
    var slug = window.location.pathname.split('/board/')[1];
    var app = document.getElementById('board-app');

    function esc(s) {
      if (s == null) return '';
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }
    function safeUrl(url) {
      if (!url || typeof url !== 'string') return '';
      try { var u = new URL(url); if (u.protocol === 'https:' || u.protocol === 'http:') return esc(url); } catch(e) {}
      return '';
    }

    async function init() {
      try {
        var res = await fetch('/api/tenants/by-slug/' + encodeURIComponent(slug) + '/board');
        if (!res.ok) {
          app.innerHTML = '<div class="empty"><h1>Board not available</h1><p>This tailnet does not have a public board.</p><a class="back-link" href="/">Go to dashboard</a></div>';
          return;
        }
        var data = await res.json();
        renderBoard(data);
      } catch (e) {
        app.innerHTML = '<div class="empty">Failed to load board.</div>';
      }
    }

    function renderBoard(data) {
      var html = '<h1>' + esc(data.tenant.name) + '</h1>' +
        '<p class="subtitle">Public service board</p>';

      if (data.posts.length === 0) {
        html += '<div class="empty">No posts yet.</div>';
      } else {
        html += data.posts.map(function(p) {
          return '<div class="post-card" onclick="showService(this, event)" data-url="' + esc(p.serviceUrl) + '" data-service-desc="' + esc(p.serviceDescription || '') + '">' +
            '<div class="post-title">' + esc(p.title) + '</div>' +
            (p.description ? '<div class="post-desc">' + esc(p.description) + '</div>' : '') +
            '<div class="post-meta">' +
              '<span class="service-tag">' + esc(p.serviceName) + '</span>' +
              '<span>by ' + esc(p.authorDisplayName || p.authorHandle) + '</span>' +
              '<span>' + new Date(p.createdAt).toLocaleDateString() + '</span>' +
            '</div>' +
          '</div>';
        }).join('');
      }

      html += '<a class="back-link" href="/">Go to dashboard</a>';
      app.innerHTML = html;
    }

    function showService(el, event) {
      var url = el.getAttribute('data-url');
      var desc = el.getAttribute('data-service-desc');
      var existing = el.querySelector('.service-detail');
      if (existing) { existing.remove(); return; }
      var detail = document.createElement('div');
      detail.className = 'service-detail';
      detail.style.cssText = 'margin-top:12px;padding:12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;font-size:13px';
      var safe = safeUrl(url);
      detail.innerHTML = (desc ? '<p style="margin-bottom:8px">' + esc(desc) + '</p>' : '') +
        (safe ? '<p>Service URL: <a href="' + safe + '" target="_blank" rel="noopener">' + safe + '</a></p>' : '<p>Service URL: ' + esc(url) + '</p>');
      el.appendChild(detail);
      event.stopPropagation();
    }

    init();
  </script>
</body>
</html>`;

boardRouter.get("/board/:slug", (_req, res) => {
  res.type("html").send(BOARD_PAGE_HTML);
});
