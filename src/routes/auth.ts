import { Router } from "express";
import { eq } from "drizzle-orm";
import { Agent } from "@atproto/api";
import { getOAuthClient } from "../auth/atproto.js";
import { db } from "../db/index.js";
import { users, tenants, memberships } from "../db/schema.js";
import { allocatePort } from "../orchestrator/ports.js";
import { createInstance } from "../orchestrator/headscale.js";
import { HeadscaleApiClient } from "../orchestrator/headscale-api.js";
import { addTenantRoute } from "../orchestrator/caddy.js";

export const authRouter = Router();

async function provisionTenant(
  user: typeof users.$inferSelect,
  displayName: string,
  handle: string,
): Promise<void> {
  const slug = handle
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();

  const port = await allocatePort();

  // Insert tenant as provisioning first
  const [tenant] = await db
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

  await db.insert(memberships).values({
    userId: user.id,
    tenantId: tenant.id,
    role: "owner",
  });

  // Provision asynchronously — don't block the redirect
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
        .where(eq(tenants.id, tenant.id));

      // Push default-allow ACL policy
      const hsClient = new HeadscaleApiClient(port, instance.apiKey);
      await hsClient
        .setPolicy({
          acls: [{ action: "accept", src: ["*"], dst: ["*:*"] }],
        })
        .catch((err) =>
          console.error(`Failed to set default policy for ${slug}:`, err),
        );

      // Register with Caddy
      await addTenantRoute(slug, port).catch((err) =>
        console.error(`Failed to add Caddy route for ${slug}:`, err),
      );

      console.log(`Tenant ${slug} provisioned on port ${port}`);
    } catch (err) {
      console.error(`Failed to provision tenant ${slug}:`, err);
      await db
        .update(tenants)
        .set({ status: "error", updatedAt: new Date() })
        .where(eq(tenants.id, tenant.id));
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
