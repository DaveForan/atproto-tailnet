/**
 * @module access/compiler
 * Turns approved service posts, device connections and shares into coordinator access rules (ADR-0036).
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
  /** Open mode: the owners (user ids) who put their own devices under the open policy. */
  open_owners?: string[];
  /** The owners (user ids) whose key admits a device without their own step (ADR-0039). */
  unheld_owners?: string[];
}

export interface CompileInput {
  mode: AccessMode;
  posts: Array<{
    id: string;
    board: string;
    status: string;
    nodeId: string;
    proto: "tcp" | "udp";
    port: number;
    authorId?: string;
  }>;
  connections: Array<{ postId: string; nodeId: string; userId?: string }>;
  shares: Array<{
    id?: string;
    status: string;
    ownerId?: string;
    guestId: string;
    ownerNodeId: string;
    guestNodeIds: string[];
    ports: AccessPortSpec[];
    expiresAt: Date | null;
  }>;
  /**
   * Current owner (user id) of each device, from the control plane.
   * A re-registered device keeps its node id, so an item with a different recorded owner is stale and opens nothing.
   * Devices absent from the map are not checked.
   */
  nodeOwners?: ReadonlyMap<string, string>;
  /** Members (user ids) who chose the tailnet's open policy for their own devices. Used in open mode. */
  openOwners?: string[];
  /** Members (user ids) who turned off the approval of their own new devices. Empty while the tailnet has the second approval. */
  unheldOwners?: string[];
  now?: Date;
}

/** What no longer matches the control plane's device owners (see `nodeOwners`). */
export interface StaleAccess {
  /** Posts whose device now belongs to someone other than the author. */
  postIds: string[];
  /** Connections whose device now belongs to someone other than the member who connected it. */
  connections: Array<{ postId: string; nodeId: string }>;
  /** Shares whose exposed device now belongs to someone other than the owner. */
  shareIds: string[];
  /** Shares that keep some, but lose other, chosen guest devices: the devices that remain. */
  guestNodes: Array<{ shareId: string; keep: string[] }>;
}

function ownerMoved(owners: ReadonlyMap<string, string> | undefined, nodeId: string, recorded: string | undefined): boolean {
  if (!owners || recorded === undefined) return false;
  const now = owners.get(nodeId);
  return now !== undefined && now !== recorded;
}

/** Finds the posts, connections and shares made stale by a device's change of owner. */
export function findStaleAccess(input: Pick<CompileInput, "posts" | "connections" | "shares" | "nodeOwners">): StaleAccess {
  const owners = input.nodeOwners;
  const stale: StaleAccess = { postIds: [], connections: [], shareIds: [], guestNodes: [] };
  if (!owners) return stale;
  for (const post of input.posts) {
    if (post.status !== "removed" && ownerMoved(owners, post.nodeId, post.authorId)) stale.postIds.push(post.id);
  }
  for (const c of input.connections) {
    if (ownerMoved(owners, c.nodeId, c.userId)) stale.connections.push({ postId: c.postId, nodeId: c.nodeId });
  }
  for (const share of input.shares) {
    if (share.status === "ended" || !share.id) continue;
    if (ownerMoved(owners, share.ownerNodeId, share.ownerId)) {
      stale.shareIds.push(share.id);
      continue;
    }
    if (share.guestNodeIds.length === 0) continue;
    const keep = share.guestNodeIds.filter((n) => !ownerMoved(owners, n, share.guestId));
    if (keep.length === share.guestNodeIds.length) continue;
    // Every chosen device left the guest: the share ends rather than widening to all devices
    if (keep.length === 0) stale.shareIds.push(share.id);
    else stale.guestNodes.push({ shareId: share.id, keep });
  }
  return stale;
}

/** A member's role, for posts that only some roles may connect to. */
export interface MemberRole {
  roleId: string | null;
  isOriginator: boolean;
}

/** True when `userId` may connect to a post with this role restriction. The author and the originator always may. */
export function roleAllows(
  post: { authorId?: string; allowedRoleIds?: string[] | null },
  userId: string | undefined,
  members: ReadonlyMap<string, MemberRole>,
): boolean {
  const allowed = post.allowedRoleIds ?? [];
  if (allowed.length === 0) return true;
  if (userId === undefined) return false;
  if (userId === post.authorId) return true;
  const member = members.get(userId);
  if (!member) return false;
  return member.isOriginator || (member.roleId !== null && allowed.includes(member.roleId));
}

/**
 * Drops the connections of members whose role may not connect to the post (any more).
 * The rows stay in the database; they open nothing while the role does not match.
 */
export function connectionsAllowedByRole<C extends { postId: string; userId?: string }>(
  posts: Array<{ id: string; authorId?: string; allowedRoleIds?: string[] | null }>,
  connections: C[],
  members: ReadonlyMap<string, MemberRole>,
): C[] {
  const byId = new Map(posts.map((p) => [p.id, p]));
  return connections.filter((c) => {
    const post = byId.get(c.postId);
    return post !== undefined && roleAllows(post, c.userId, members);
  });
}

/** True when a share is active and its expiry has not passed at `now`. */
export function shareIsLive(share: { status: string; expiresAt: Date | null }, now: Date): boolean {
  return share.status === "active" && !(share.expiresAt && share.expiresAt.getTime() <= now.getTime());
}

/** Control-plane node ids are positive integers; anything else is dropped. */
function nodeNumber(id: string): number | null {
  return /^[1-9]\d{0,15}$/.test(id) ? Number(id) : null;
}

/**
 * Compiles the rule set of one tailnet.
 * - A public service post opens its one port to the devices connected to it,
 *   and only while the post is approved.
 * - A share opens the listed ports of the owner's device to the guest's
 *   devices (all of them, or the chosen ones) while it is active and not
 *   expired.
 * - Private-board posts add nothing: a member's own devices already reach
 *   each other.
 * - "open" mode adds the tailnet's policy between the devices of the members
 *   in `openOwners` only. The rules are the same in both modes, because every
 *   other member's devices stay as in "member" mode.
 */
export function compileAccess(input: CompileInput): CoordinatorAccess {
  const now = input.now ?? new Date();
  const rules: CoordinatorAccessRule[] = [];

  const owners = input.nodeOwners;
  const byPost = new Map<string, number[]>();
  for (const c of input.connections) {
    if (ownerMoved(owners, c.nodeId, c.userId)) continue;
    const n = nodeNumber(c.nodeId);
    if (n === null) continue;
    const list = byPost.get(c.postId) ?? [];
    if (!list.includes(n)) list.push(n);
    byPost.set(c.postId, list);
  }
  for (const post of input.posts) {
    if (post.board !== "public" || post.status !== "approved") continue;
    if (ownerMoved(owners, post.nodeId, post.authorId)) continue;
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
    // An expired share is closed from the first push after its expiry, even
    // before the monitor marks it ended
    if (!shareIsLive(share, now)) continue;
    if (ownerMoved(owners, share.ownerNodeId, share.ownerId)) continue;
    const dst = nodeNumber(share.ownerNodeId);
    if (dst === null || share.ports.length === 0) continue;
    const ports = share.ports.map((p) => ({ proto: p.proto, first: p.first, last: p.last }));
    if (share.guestNodeIds.length === 0) {
      rules.push({ src_owner: share.guestId, dst_node: dst, ports });
      continue;
    }
    const guestNodes = share.guestNodeIds.filter((n) => !ownerMoved(owners, n, share.guestId));
    const sources = [...new Set(guestNodes.map(nodeNumber).filter((n): n is number => n !== null))].sort(
      (a, b) => a - b,
    );
    // Chosen devices that no longer exist must not widen the share to all devices
    if (sources.length === 0) continue;
    for (let i = 0; i < sources.length; i += MAX_RULE_SOURCES) {
      rules.push({ src_nodes: sources.slice(i, i + MAX_RULE_SOURCES), dst_node: dst, ports });
    }
  }

  const unheld = [...new Set(input.unheldOwners ?? [])].sort();
  const held = unheld.length ? { unheld_owners: unheld } : {};
  if (input.mode !== "member") return { mode: "open", rules, open_owners: [...new Set(input.openOwners ?? [])].sort(), ...held };
  return { mode: "member", rules, ...held };
}

export interface CoordinatorDnsRecord {
  name: string;
  node: number;
  owner?: string;
  nodes?: number[];
  /** Set for a web service: the gateway serves the name over HTTPS and passes requests to this port. */
  port?: number;
}

export interface CoordinatorDns {
  base_domain: string | null;
  tailnet_label: string | null;
  upstream: string[];
  records: CoordinatorDnsRecord[];
}

export interface DnsInput {
  baseDomain: string;
  tailnetLabel: string;
  upstream: string[];
  posts: Array<{
    id: string;
    board: string;
    status: string;
    name: string | null;
    nodeId: string;
    authorId: string;
    proto?: string;
    port?: number;
    web?: boolean;
  }>;
  connections: Array<{ postId: string; nodeId: string; userId?: string }>;
  /** As in `CompileInput`: names on a device that changed owner are dropped. */
  nodeOwners?: ReadonlyMap<string, string>;
}

/**
 * Compiles the DNS names of a tailnet's services (ADR-0028).
 * - A private-board service resolves only on its author's devices.
 * - An approved public service resolves on its author's devices and on the
 *   devices connected to it.
 * - A name equal to the tailnet's own label is skipped: it would shadow the
 *   namespace of device names.
 */
export function compileDns(input: DnsInput): CoordinatorDns {
  const records: CoordinatorDnsRecord[] = [];
  for (const post of input.posts) {
    if (!post.name || post.name === input.tailnetLabel) continue;
    const node = nodeNumber(post.nodeId);
    if (node === null) continue;
    if (ownerMoved(input.nodeOwners, post.nodeId, post.authorId)) continue;
    // A web service is reached through the gateway on its HTTPS name
    const web = post.web && post.proto === "tcp" && post.port ? { port: post.port } : {};
    if (post.board === "private" && post.status !== "removed" && post.status !== "rejected") {
      records.push({ name: post.name, node, owner: post.authorId, ...web });
    } else if (post.board === "public" && post.status === "approved") {
      const nodes = [
        ...new Set(
          input.connections
            .filter((c) => c.postId === post.id && !ownerMoved(input.nodeOwners, c.nodeId, c.userId))
            .map((c) => nodeNumber(c.nodeId))
            .filter((n): n is number => n !== null),
        ),
      ]
        .sort((a, b) => a - b)
        .slice(0, MAX_RULE_SOURCES);
      records.push({ name: post.name, node, owner: post.authorId, ...(nodes.length ? { nodes } : {}), ...web });
    }
  }
  records.sort((a, b) => a.name.localeCompare(b.name) || a.node - b.node);
  return { base_domain: input.baseDomain, tailnet_label: input.tailnetLabel, upstream: input.upstream, records };
}
