/**
 * @module orchestrator/control-types
 * Shapes of the coordinator's devices, keys and routes as the service uses them.
 */

/** Who must admit a device next. `none` means admitted. */
export type DeviceHold = "none" | "approver" | "owner";

export interface ControlNode {
  id: string;
  machineKey?: string;
  nodeKey?: string;
  name: string;
  givenName?: string;
  /** The owner (our user id) in `id` and `name`. Null for a device without an owner. */
  user?: { id?: string; name: string } | null;
  ipAddresses?: string[];
  online?: boolean;
  lastSeen?: string | null;
  expiry?: string | null;
  availableRoutes?: string[];
  approvedRoutes?: string[];
  /** Approved routes for which this node is the primary router. */
  subnetRoutes?: string[];
  hold: DeviceHold;
  /** Short form of the machine key. */
  fingerprint?: string;
  os?: string;
}

export interface ControlPreAuthKey {
  id?: string;
  key: string;
  reusable?: boolean;
  ephemeral?: boolean;
  used?: boolean;
  expiration?: string;
  createdAt?: string;
}

/** The coordinator has no route objects, so `id` comes from the node id and prefix (see {@link routeId}). */
export interface ControlRoute {
  id: string;
  node: { id: string; name: string; givenName?: string; online?: boolean };
  prefix: string;
  advertised: boolean;
  enabled: boolean;
  isPrimary: boolean;
}

const EXIT_ROUTES = ["0.0.0.0/0", "::/0"];

export interface PreAuthKeyOptions {
  reusable?: boolean;
  ephemeral?: boolean;
  expirationSeconds?: number;
  /** Our user id. A device that registers with the key belongs to this member. */
  owner?: string;
  tags?: string[];
}

/** Never includes the secret. */
export interface ControlPreAuthKeyInfo {
  id: string;
  prefix: string;
  owner: string | null;
  tags: string[];
  reusable: boolean;
  ephemeral: boolean;
  used: boolean;
  expiresAt: string | null;
  createdAt: string | null;
  revoked: boolean;
}

/** Route auto-approvers in the coordinator wire shape. */
export interface AutoApproversConfig {
  routes: Record<string, string[]>;
  exit_node: string[];
}

/** URL- and attribute-safe id for one node's route: `<nodeId>-<base64url(prefix)>`. */
export function routeId(nodeId: string, prefix: string): string {
  return `${nodeId}-${Buffer.from(prefix).toString("base64url")}`;
}

/** Also accepts `<nodeId>:<cidr>`, with the `/` percent-encoded in URLs. Returns null when malformed. */
export function parseRouteId(id: string): { nodeId: string; prefix: string } | null {
  const plain = /^(\d+):([0-9A-Fa-f.:]+\/\d{1,3})$/.exec(id);
  if (plain) return { nodeId: plain[1], prefix: plain[2] };
  const m = /^(\d+)-([A-Za-z0-9_-]+)$/.exec(id);
  if (!m) return null;
  const prefix = Buffer.from(m[2], "base64url").toString();
  if (routeId(m[1], prefix) !== id) return null;
  return { nodeId: m[1], prefix };
}

/** Everything the node advertises plus anything still approved. */
export function routesOfNode(node: ControlNode): ControlRoute[] {
  const available = node.availableRoutes ?? [];
  const approved = node.approvedRoutes ?? [];
  const primary = node.subnetRoutes ?? [];
  return [...new Set([...available, ...approved])].map((prefix) => ({
    id: routeId(node.id, prefix),
    node: {
      id: node.id,
      name: node.name,
      givenName: node.givenName,
      online: node.online,
    },
    prefix,
    advertised: available.includes(prefix),
    enabled: approved.includes(prefix),
    isPrimary: primary.includes(prefix),
  }));
}

/** The two exit routes (`0.0.0.0/0`, `::/0`) are one decision and always move together. */
export function withRouteApproval(
  approved: string[],
  prefix: string,
  enable: boolean,
): string[] {
  const affected = EXIT_ROUTES.includes(prefix) ? EXIT_ROUTES : [prefix];
  const rest = approved.filter((p) => !affected.includes(p));
  return enable ? [...rest, ...affected] : rest;
}
