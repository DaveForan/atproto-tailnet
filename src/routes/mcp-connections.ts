/**
 * @module routes/mcp-connections
 * The signed-in user's MCP OAuth grants ("connections") for the dashboard:
 *
 * - GET    /api/mcp/connections      → [{id, clientName, operator, createdAt, lastUsedAt}]
 *   (`operator: true` when the grant includes the instance-operator scope)
 * - DELETE /api/mcp/connections/:id  → revokes the grant and all its tokens
 *
 * Dashboard session only: agent tokens and MCP tokens cannot list or revoke
 * connections (an MCP client must not manage its own or other grants).
 * DELETE is CSRF-protected by the global middleware (session request).
 */
import { Router } from "express";
import { requireSession, param } from "./helpers.js";
import { oauthProvider } from "../oauth/index.js";
import type { TailnetOAuthProvider } from "../oauth/provider.js";

export function createMcpConnectionsRouter(provider: TailnetOAuthProvider): Router {
  const router = Router();

  router.get("/api/mcp/connections", requireSession, async (req, res) => {
    const grants = await provider.store.listActiveGrants(req.session.userId!);
    res.json(
      grants.map((g) => ({
        id: g.id,
        clientName: g.clientName,
        operator: g.operator,
        createdAt: g.createdAt,
        lastUsedAt: g.lastUsedAt,
      })),
    );
  });

  router.delete("/api/mcp/connections/:id", requireSession, async (req, res) => {
    const id = param(req, "id");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      res.status(404).json({ error: "Connection not found" });
      return;
    }
    const revoked = await provider.revokeGrantForUser(req.session.userId!, id);
    if (!revoked) {
      res.status(404).json({ error: "Connection not found" });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}

export const mcpConnectionsRouter = createMcpConnectionsRouter(oauthProvider);
