/**
 * @module routes/auth
 * AT Protocol OAuth login/callback/logout and .well-known endpoint serving.
 * Also handles first-login tenant provisioning (async via setImmediate).
 */

import { Router } from "express";
import { eq } from "drizzle-orm";
import { Agent } from "@atproto/api";
import {
  getOAuthClient,
  getClientMetadata,
  getPublicJwks,
} from "../auth/atproto.js";
import { db } from "../db/index.js";
import { users, tenants, memberships, roles } from "../db/schema.js";
import { allocatePort } from "../orchestrator/ports.js";
import { adoptInstance, createInstance } from "../orchestrator/headscale.js";
import { syncTenantRoutes } from "../orchestrator/caddy.js";
import { getControlClient, useCoordinator } from "../orchestrator/control-client.js";
import {
  ORIGINATOR_PERMISSIONS,
  DEFAULT_CITIZEN_PERMISSIONS,
} from "./permissions.js";
import { logger } from "../logger.js";

/**
 * Router for authentication routes: login initiation, OAuth callback,
 * logout, and AT Proto .well-known metadata/JWKS endpoints.
 */
export const authRouter = Router();

async function generateUniqueSlug(handle: string): Promise<string> {
  const base = handle
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  const [existing] = await db
    .select({ slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.slug, base));
  if (!existing) return base;
  for (let i = 2; i <= 100; i++) {
    const candidate = `${base}-${i}`;
    const [check] = await db
      .select({ slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.slug, candidate));
    if (!check) return candidate;
  }
  throw new Error("Could not generate unique slug");
}

async function provisionTenant(
  user: typeof users.$inferSelect,
  displayName: string,
  handle: string,
): Promise<void> {
  const slug = await generateUniqueSlug(handle);
  const { allocateTenantPrefixes } = await import("../orchestrator/prefix-allocator.js");
  const prefixes = await allocateTenantPrefixes();

  let tenant: typeof tenants.$inferSelect | undefined;
  let port = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    port = await allocatePort();
    try {
      const [inserted] = await db
        .insert(tenants)
        .values({
          slug,
          name: `${displayName}'s tailnet`,
          ownerUserId: user.id,
          port,
          apiKey: "",
          status: "provisioning",
          ipv4Prefix: prefixes.ipv4Prefix,
          ipv6Prefix: prefixes.ipv6Prefix,
        })
        .returning();
      tenant = inserted;
      break;
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (attempt === 2 || pgErr.code !== "23505") throw err;
    }
  }
  if (!tenant) throw new Error("Failed to create tenant after retries");

  // Create system roles
  const [originatorRole] = await db
    .insert(roles)
    .values({
      tenantId: tenant.id,
      name: "originator",
      description: "Full control over the tailnet",
      permissions: [...ORIGINATOR_PERMISSIONS],
      isSystem: true,
    })
    .returning();

  const [citizenRole] = await db
    .insert(roles)
    .values({
      tenantId: tenant.id,
      name: "citizen",
      description: "Default role for new members",
      permissions: [...DEFAULT_CITIZEN_PERMISSIONS],
      isSystem: true,
    })
    .returning();

  // Set citizen as the default role for new members
  await db
    .update(tenants)
    .set({ defaultRoleId: citizenRole.id })
    .where(eq(tenants.id, tenant.id));

  // Create originator membership
  await db.insert(memberships).values({
    userId: user.id,
    tenantId: tenant.id,
    role: "owner",
    roleId: originatorRole.id,
    isOriginator: true,
  });

  setImmediate(() => {
    void provisionTenantInstance(tenant!.id, slug, port);
  });
}

/**
 * Bring a tenant's control-plane instance up and mark the tenant running.
 *
 * In coordinator mode: creates the tenant in the Rust coordinator via REST,
 * stores the coordinator-side tenant UUID, sets default policy.
 *
 * In Headscale mode: starts a Docker container (or adopts a leftover one),
 * stores its API key, installs the default ACL policy.
 *
 * Both modes sync Caddy routes at the end. On failure the tenant is marked "error".
 */
export async function provisionTenantInstance(
  tenantId: string,
  slug: string,
  port: number,
): Promise<boolean> {
  try {
    if (useCoordinator) {
      await provisionViaCoordinator(tenantId, slug, port);
    } else {
      await provisionViaHeadscale(tenantId, slug, port);
    }

    await syncTenantRoutes().catch((err) =>
      logger.error({ tenantSlug: slug, err }, "failed to sync Caddy routes"),
    );

    logger.info({ tenantSlug: slug, port, mode: useCoordinator ? "coordinator" : "headscale" }, "tenant provisioned");
    return true;
  } catch (err) {
    logger.error({ tenantSlug: slug, err }, "failed to provision tenant");
    await db
      .update(tenants)
      .set({ status: "error", updatedAt: new Date() })
      .where(eq(tenants.id, tenantId));
    return false;
  }
}

/** Sentinel value stored in apiKey for coordinator-mode tenants. */
const COORDINATOR_API_KEY_SENTINEL = "__coordinator__";

async function provisionViaCoordinator(
  tenantId: string,
  slug: string,
  _port: number,
): Promise<void> {
  const { config } = await import("../config.js");
  const coordUrl = config.coordinatorUrl!;

  const res = await fetch(`${coordUrl}/api/tenants`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.coordinatorApiKey
        ? { Authorization: `Bearer ${config.coordinatorApiKey}` }
        : {}),
    },
    body: JSON.stringify({ slug }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Coordinator tenant creation failed (${res.status}): ${text}`);
  }

  const coordTenant = (await res.json()) as { id: string };

  try {
    await db
      .update(tenants)
      .set({
        coordinatorTenantId: coordTenant.id,
        apiKey: COORDINATOR_API_KEY_SENTINEL,
        status: "running",
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, tenantId));

    const client = getControlClient({
      port: 0,
      apiKey: COORDINATOR_API_KEY_SENTINEL,
      coordinatorTenantId: coordTenant.id,
    });

    await client.setPolicy({
      acls: [{ action: "accept", src: ["*"], dst: ["*:*"] }],
    });
  } catch (err) {
    // Compensating delete — best effort
    try {
      await fetch(`${coordUrl}/api/tenants/${coordTenant.id}`, {
        method: "DELETE",
        headers: config.coordinatorApiKey
          ? { Authorization: `Bearer ${config.coordinatorApiKey}` }
          : {},
      });
    } catch {
      // Best-effort cleanup; log the original error
    }
    throw err;
  }
}

async function provisionViaHeadscale(
  tenantId: string,
  slug: string,
  port: number,
): Promise<void> {
  const instance =
    (await adoptInstance(slug, port)) ?? (await createInstance(slug, port));

  await db
    .update(tenants)
    .set({
      apiKey: instance.apiKey,
      containerId: instance.containerId,
      status: "running",
      updatedAt: new Date(),
    })
    .where(eq(tenants.id, tenantId));

  const client = getControlClient({
    port,
    apiKey: instance.apiKey,
  });

  await client.setPolicy({
    acls: [{ action: "accept", src: ["*"], dst: ["*:*"] }],
  });
}

authRouter.get("/auth/login", async (req, res) => {
  try {
    const handle = req.query.handle as string;
    if (!handle) {
      res.status(400).json({ error: "handle query parameter required" });
      return;
    }

    const redirect = req.query.redirect as string | undefined;
    if (redirect && /^\/[a-z0-9]/.test(redirect)) {
      req.session.postLoginRedirect = redirect;
    }

    const client = await getOAuthClient();
    const url = await client.authorize(handle, {
      scope: "atproto transition:generic",
    });

    res.redirect(url.toString());
  } catch (err) {
    logger.error({ err }, "login initiation failed");
    res.status(500).json({ error: "Failed to initiate login" });
  }
});

authRouter.get("/auth/callback", async (req, res) => {
  try {
    const client = await getOAuthClient();
    const params = new URLSearchParams(req.url.split("?")[1]);
    const { session } = await client.callback(params);

    const did = session.did;

    const agent = new Agent(session);
    const profile = await agent.getProfile({ actor: did });
    const handle = profile.data.handle;
    const displayName = profile.data.displayName ?? handle;
    const avatarUrl = profile.data.avatar ?? null;

    let [user] = await db.select().from(users).where(eq(users.did, did));

    if (!user) {
      [user] = await db
        .insert(users)
        .values({ did, handle, displayName, avatarUrl })
        .returning();

      await provisionTenant(user, displayName, handle);
    } else {
      await db
        .update(users)
        .set({ handle, displayName, avatarUrl, updatedAt: new Date() })
        .where(eq(users.id, user.id));
    }

    const dest = req.session.postLoginRedirect || "/";
    req.session.regenerate((err) => {
      if (err) {
        logger.error({ err }, "session regeneration failed");
        res.status(500).json({ error: "Authentication failed" });
        return;
      }
      req.session.userId = user.id;
      req.session.did = did;
      req.session.save((err) => {
        if (err) {
          res.status(500).json({ error: "Session save failed" });
          return;
        }
        res.redirect(dest);
      });
    });
  } catch (err) {
    logger.error({ err }, "OAuth callback failed");
    res.status(500).json({ error: "Authentication failed" });
  }
});

authRouter.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

authRouter.get("/.well-known/atproto-client-metadata.json", (_req, res) => {
  res.json(getClientMetadata());
});

authRouter.get("/.well-known/jwks.json", async (_req, res) => {
  try {
    const jwks = await getPublicJwks();
    res.json(jwks);
  } catch (err) {
    logger.error({ err }, "failed to generate JWKS");
    res.status(500).json({ error: "JWKS not available" });
  }
});
