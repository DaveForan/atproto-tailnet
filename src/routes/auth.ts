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
import { createInstance } from "../orchestrator/headscale.js";
import { HeadscaleApiClient } from "../orchestrator/headscale-api.js";
import { addTenantRoute } from "../orchestrator/caddy.js";
import {
  ORIGINATOR_PERMISSIONS,
  DEFAULT_CITIZEN_PERMISSIONS,
} from "./permissions.js";

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

  setImmediate(async () => {
    try {
      const instance = await createInstance(slug, port);

      await db
        .update(tenants)
        .set({
          apiKey: instance.apiKey,
          containerId: instance.containerId,
          status: "running",
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, tenant!.id));

      const hsClient = new HeadscaleApiClient(port, instance.apiKey);
      await hsClient
        .setPolicy({
          acls: [{ action: "accept", src: ["*"], dst: ["*:*"] }],
        })
        .catch((err) =>
          console.error(`Failed to set default policy for ${slug}:`, err),
        );

      await addTenantRoute(slug, port).catch((err) =>
        console.error(`Failed to add Caddy route for ${slug}:`, err),
      );

      console.log(`Tenant ${slug} provisioned on port ${port}`);
    } catch (err) {
      console.error(`Failed to provision tenant ${slug}:`, err);
      await db
        .update(tenants)
        .set({ status: "error", updatedAt: new Date() })
        .where(eq(tenants.id, tenant!.id));
    }
  });
}

authRouter.get("/auth/login", async (req, res) => {
  try {
    const handle = req.query.handle as string;
    if (!handle) {
      res.status(400).json({ error: "handle query parameter required" });
      return;
    }

    const client = await getOAuthClient();
    const url = await client.authorize(handle, {
      scope: "atproto transition:generic",
    });

    res.redirect(url.toString());
  } catch (err) {
    console.error("Login error:", err);
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

    req.session.userId = user.id;
    req.session.did = did;

    res.redirect("/");
  } catch (err) {
    console.error("Callback error:", err);
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
    console.error("Failed to generate JWKS:", err);
    res.status(500).json({ error: "JWKS not available" });
  }
});
