/**
 * @module access/compiler
 * Turns a tailnet's approved service posts, device connections and shares
 * between friends into the access rules the coordinator enforces (ADR-0036).
 * Pure: no database or network access.
 */

import type { AccessPortSpec } from "../db/schema.js";

/** Matches the coordinator's MAX_RULE_SOURCES. */
export const MAX_RULE_SOURCES = 256;

export type AccessMode = "open" | "member";

/** One rule in the coordinator's wire format. */
export interface CoordinatorAccessRule {
  src_owner?: string;
  src_nodes?: number[];
  dst_node: number;
  ports: AccessPortSpec[];
}

export interface CoordinatorAccess {
  mode: AccessMode;
  rules: CoordinatorAccessRule[];
}

export interface CompileInput {
  mode: AccessMode;
  posts: Array<{ id: string; board: string; status: string; nodeId: string; proto: "tcp" | "udp"; port: number }>;
  connections: Array<{ postId: string; nodeId: string }>;
  shares: Array<{
    status: string;
    guestId: string;
    ownerNodeId: string;
    guestNodeIds: string[];
    ports: AccessPortSpec[];
    expiresAt: Date | null;
  }>;
  now?: Date;
}

/** Control-plane node ids are positive integers; anything else is dropped. */
function nodeNumber(id: string): number | null {
  return /^[1-9]\d{0,15}$/.test(id) ? Number(id) : null;
}

/**
 * Compile the rule set of one tailnet.
 *
 * - A public service post opens its one port to the devices connected to it,
 *   and only while the post is approved.
 * - A share opens the listed ports of the owner's device to the guest's
 *   devices (all of them, or the chosen ones) while it is active and not
 *   expired.
 * - Private-board posts add nothing: a member's own devices already reach
 *   each other.
 * - In "open" mode the coordinator ignores rules, so none are sent.
 */
export function compileAccess(input: CompileInput): CoordinatorAccess {
  if (input.mode !== "member") return { mode: "open", rules: [] };
  const now = input.now ?? new Date();
  const rules: CoordinatorAccessRule[] = [];

  const byPost = new Map<string, number[]>();
  for (const c of input.connections) {
    const n = nodeNumber(c.nodeId);
    if (n === null) continue;
    const list = byPost.get(c.postId) ?? [];
    if (!list.includes(n)) list.push(n);
    byPost.set(c.postId, list);
  }
  for (const post of input.posts) {
    if (post.board !== "public" || post.status !== "approved") continue;
    const dst = nodeNumber(post.nodeId);
    const sources = (byPost.get(post.id) ?? []).filter((n) => n !== dst).sort((a, b) => a - b);
    if (dst === null || sources.length === 0) continue;
    for (let i = 0; i < sources.length; i += MAX_RULE_SOURCES) {
      rules.push({
        src_nodes: sources.slice(i, i + MAX_RULE_SOURCES),
        dst_node: dst,
        ports: [{ proto: post.proto, first: post.port, last: post.port }],
      });
    }
  }

  for (const share of input.shares) {
    if (share.status !== "active") continue;
    if (share.expiresAt && share.expiresAt.getTime() <= now.getTime()) continue;
    const dst = nodeNumber(share.ownerNodeId);
    if (dst === null || share.ports.length === 0) continue;
    const ports = share.ports.map((p) => ({ proto: p.proto, first: p.first, last: p.last }));
    if (share.guestNodeIds.length === 0) {
      rules.push({ src_owner: share.guestId, dst_node: dst, ports });
      continue;
    }
    const sources = [...new Set(share.guestNodeIds.map(nodeNumber).filter((n): n is number => n !== null))].sort(
      (a, b) => a - b,
    );
    // Chosen devices that no longer exist must not widen the share to all devices
    if (sources.length === 0) continue;
    for (let i = 0; i < sources.length; i += MAX_RULE_SOURCES) {
      rules.push({ src_nodes: sources.slice(i, i + MAX_RULE_SOURCES), dst_node: dst, ports });
    }
  }

  return { mode: "member", rules };
}
