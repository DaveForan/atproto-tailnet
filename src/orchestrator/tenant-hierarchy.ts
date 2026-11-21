/**
 * @module orchestrator/tenant-hierarchy
 * Materialized paths of the sub-collective tree (`tenants.path`, `tenants.depth`).
 */

import { and, eq, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants } from "../db/schema.js";

/** Rewrites path and depth of every live descendant below a moved collective. */
export async function rebuildDescendantPaths(
  parentId: string,
  parentPath: string,
  parentDepth: number,
): Promise<void> {
  const children = await db
    .select({ id: tenants.id, slug: tenants.slug })
    .from(tenants)
    .where(and(eq(tenants.parentId, parentId), ne(tenants.status, "deleted")));

  for (const child of children) {
    const childPath = `${parentPath}.${child.slug}`;
    const childDepth = parentDepth + 1;
    await db
      .update(tenants)
      .set({ path: childPath, depth: childDepth, updatedAt: new Date() })
      .where(eq(tenants.id, child.id));
    await rebuildDescendantPaths(child.id, childPath, childDepth);
  }
}
