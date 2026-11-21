/**
 * @module access/reach
 * Who can reach one device (ADR-0036): the same posts, connections and shares that `compileAccess` turns into rules,
 * kept with their reason. Pure: no database or network access.
 */

import type { AccessPortSpec } from "../db/schema.js";
import { shareIsLive, type CompileInput } from "./compiler.js";

/** One reason why devices of another member reach the device. */
export interface ReachEntry {
  kind: "service" | "share";
  /** The post or the share. */
  id: string;
  /** The member whose devices get in. */
  userId: string;
  /** Node ids of that member, or "all" for every device of the member. */
  devices: string[] | "all";
  ports: AccessPortSpec[];
  expiresAt: Date | null;
}

export type ReachInput = Pick<CompileInput, "posts" | "connections" | "shares" | "nodeOwners" | "now">;

function moved(owners: ReadonlyMap<string, string> | undefined, nodeId: string, recorded: string | undefined): boolean {
  if (!owners || recorded === undefined) return false;
  const now = owners.get(nodeId);
  return now !== undefined && now !== recorded;
}

/**
 * The entries that open `nodeId` in "member" mode. It must agree with `compileAccess`:
 * the test `reach agrees with the compiled rules` compares the two.
 */
export function deviceReach(input: ReachInput, nodeId: string): ReachEntry[] {
  const now = input.now ?? new Date();
  const owners = input.nodeOwners;
  const out: ReachEntry[] = [];

  for (const post of input.posts) {
    if (post.nodeId !== nodeId || post.board !== "public" || post.status !== "approved") continue;
    if (moved(owners, post.nodeId, post.authorId)) continue;
    const byUser = new Map<string, string[]>();
    for (const c of input.connections) {
      if (c.postId !== post.id || c.nodeId === nodeId || c.userId === undefined) continue;
      if (moved(owners, c.nodeId, c.userId)) continue;
      const list = byUser.get(c.userId) ?? [];
      if (!list.includes(c.nodeId)) list.push(c.nodeId);
      byUser.set(c.userId, list);
    }
    for (const [userId, devices] of byUser) {
      out.push({
        kind: "service",
        id: post.id,
        userId,
        devices,
        ports: [{ proto: post.proto, first: post.port, last: post.port }],
        expiresAt: null,
      });
    }
  }

  for (const share of input.shares) {
    if (share.ownerNodeId !== nodeId || !share.id || !shareIsLive(share, now)) continue;
    if (moved(owners, share.ownerNodeId, share.ownerId) || share.ports.length === 0) continue;
    let devices: string[] | "all" = "all";
    if (share.guestNodeIds.length > 0) {
      devices = [...new Set(share.guestNodeIds.filter((n) => !moved(owners, n, share.guestId)))];
      if (devices.length === 0) continue;
    }
    out.push({ kind: "share", id: share.id, userId: share.guestId, devices, ports: share.ports, expiresAt: share.expiresAt });
  }
  return out;
}
