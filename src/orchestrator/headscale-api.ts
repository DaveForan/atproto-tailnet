/**
 * @module orchestrator/headscale-api
 * REST client for the Headscale gRPC-gateway API (v1). Zod validates every response.
 */

import { z } from "zod";

const headscaleNodeSchema = z.object({
  id: z.string(),
  machineKey: z.string().optional(),
  nodeKey: z.string().optional(),
  name: z.string(),
  givenName: z.string().optional(),
  // A single-node fetch returns null for tagged nodes, which belong to no user
  user: z
    .object({
      id: z.string().optional(),
      name: z.string(),
    })
    .nullish(),
  ipAddresses: z.array(z.string()).optional(),
  online: z.boolean().optional(),
  // Headscale sends null `expiry` for nodes that never expire.
  // It sends null `lastSeen` for nodes that have not connected yet.
  lastSeen: z.string().nullish(),
  expiry: z.string().nullish(),
  /** Headscale 0.26+ reports routes on the node. */
  availableRoutes: z.array(z.string()).optional(),
  approvedRoutes: z.array(z.string()).optional(),
  /** Approved routes for which this node is the primary router. */
  subnetRoutes: z.array(z.string()).optional(),
  /** Coordinator only: who must admit the device before it gets access. */
  hold: z.enum(["none", "approver", "owner"]).optional(),
  /** Coordinator only: short form of the machine key. */
  fingerprint: z.string().optional(),
  os: z.string().optional(),
});

const headscaleUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string().optional(),
});

const headscalePreAuthKeySchema = z.object({
  id: z.string().optional(),
  key: z.string(),
  // Headscale 0.26+ returns an object; older versions return the user name
  user: z.union([z.string(), headscaleUserSchema]).nullish(),
  reusable: z.boolean().optional(),
  ephemeral: z.boolean().optional(),
  used: z.boolean().optional(),
  expiration: z.string().optional(),
  createdAt: z.string().optional(),
});

export type HeadscaleNode = z.infer<typeof headscaleNodeSchema>;
/** Who must admit a device next. `none` means admitted. */
export type DeviceHold = NonNullable<HeadscaleNode["hold"]>;
export type HeadscaleUser = z.infer<typeof headscaleUserSchema>;
export type HeadscalePreAuthKey = z.infer<typeof headscalePreAuthKeySchema>;
/** Headscale has no route objects, so `id` comes from the node id and prefix (see {@link routeId}). */
export interface HeadscaleRoute {
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
  /** Our user id. The coordinator records it; Headscale ignores it. */
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
export function routesOfNode(node: HeadscaleNode): HeadscaleRoute[] {
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

const HEADSCALE_REQUEST_TIMEOUT_MS = 10_000;

/** Client for one Headscale container on its localhost-bound port. */
export class HeadscaleApiClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(port: number, apiKey: string) {
    this.baseUrl = `http://localhost:${port}`;
    this.apiKey = apiKey;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      // A hung container must not stall the monitor sweep or a request handler
      signal: AbortSignal.timeout(HEADSCALE_REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Headscale API ${method} ${path} failed (${res.status}): ${text}`,
      );
    }

    if (res.status === 204) return null;
    return res.json();
  }

  async createUser(name: string): Promise<HeadscaleUser> {
    const data = (await this.request("POST", "/api/v1/user", {
      name,
    })) as { user: unknown };
    return headscaleUserSchema.parse(data.user);
  }

  async listUsers(): Promise<HeadscaleUser[]> {
    const data = (await this.request("GET", "/api/v1/user")) as {
      users: unknown[];
    };
    return data.users.map((u) => headscaleUserSchema.parse(u));
  }

  async getUserByName(name: string): Promise<HeadscaleUser | null> {
    const data = (await this.request(
      "GET",
      `/api/v1/user?name=${encodeURIComponent(name)}`,
    )) as { users?: unknown[] };
    const users = (data.users ?? []).map((u) => headscaleUserSchema.parse(u));
    return users.find((u) => u.name === name) ?? null;
  }

  /** The API addresses users by numeric id, so this resolves the name first. */
  async deleteUser(name: string): Promise<void> {
    const user = await this.getUserByName(name);
    if (!user) return;
    await this.request("DELETE", `/api/v1/user/${encodeURIComponent(user.id)}`);
  }

  /** Defaults to a single-use, non-ephemeral key that expires in 24h. */
  async createPreAuthKey(
    userName: string,
    opts?: PreAuthKeyOptions,
  ): Promise<HeadscalePreAuthKey> {
    const user = await this.getUserByName(userName);
    if (!user) throw new Error(`Headscale user "${userName}" not found`);
    const expiration = opts?.expirationSeconds
      ? new Date(Date.now() + opts.expirationSeconds * 1000).toISOString()
      : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const data = (await this.request("POST", "/api/v1/preauthkey", {
      user: user.id,
      reusable: opts?.reusable ?? false,
      ephemeral: opts?.ephemeral ?? false,
      expiration,
      ...(opts?.tags?.length ? { aclTags: opts.tags } : {}),
    })) as { preAuthKey: unknown };
    return headscalePreAuthKeySchema.parse(data.preAuthKey);
  }

  /** Headscale 0.28+ addresses keys by id and rejects expired keys, even reusable ones. */
  async expirePreAuthKey(id: string): Promise<void> {
    await this.request("POST", "/api/v1/preauthkey/expire", { id });
  }

  async listPreAuthKeys(): Promise<ControlPreAuthKeyInfo[]> {
    const data = (await this.request("GET", "/api/v1/preauthkey")) as {
      preAuthKeys?: unknown[];
    };
    return (data.preAuthKeys ?? []).map((raw) => {
      const k = headscalePreAuthKeySchema
        .extend({ aclTags: z.array(z.string()).optional() })
        .parse(raw);
      const expired = k.expiration ? new Date(k.expiration).getTime() <= Date.now() : false;
      return {
        id: k.id ?? "",
        prefix: k.key.slice(0, 12),
        owner: typeof k.user === "object" && k.user ? k.user.name : (k.user ?? null),
        tags: k.aclTags ?? [],
        reusable: k.reusable ?? false,
        ephemeral: k.ephemeral ?? false,
        used: k.used ?? false,
        expiresAt: k.expiration ?? null,
        createdAt: k.createdAt ?? null,
        revoked: expired,
      };
    });
  }

  async getAutoApprovers(): Promise<AutoApproversConfig> {
    const policy = (await this.getPolicy()) as {
      autoApprovers?: { routes?: Record<string, string[]>; exitNode?: string[] };
    };
    return {
      routes: policy.autoApprovers?.routes ?? {},
      exit_node: policy.autoApprovers?.exitNode ?? [],
    };
  }

  /** Keeps the rest of the policy. */
  async setAutoApprovers(aa: AutoApproversConfig): Promise<void> {
    const policy = (await this.getPolicy()) as Record<string, unknown>;
    await this.setPolicy({
      ...policy,
      autoApprovers: { routes: aa.routes, exitNode: aa.exit_node },
    });
  }

  /** Returns the number of nodes deleted. */
  async deleteNodesByUser(userName: string): Promise<number> {
    const nodes = (await this.listNodes()).filter((n) => n.user?.name === userName);
    for (const n of nodes) await this.deleteNode(n.id);
    return nodes.length;
  }

  /** For relay nodes, which belong to no member and are governed only by ACL. */
  async createTaggedPreAuthKey(
    aclTags: string[],
    opts?: { expirationSeconds?: number; ephemeral?: boolean },
  ): Promise<HeadscalePreAuthKey> {
    const expiration = new Date(
      Date.now() + (opts?.expirationSeconds ?? 300) * 1000,
    ).toISOString();

    const data = (await this.request("POST", "/api/v1/preauthkey", {
      aclTags,
      reusable: false,
      ephemeral: opts?.ephemeral ?? false,
      expiration,
    })) as { preAuthKey: unknown };
    return headscalePreAuthKeySchema.parse(data.preAuthKey);
  }

  async listNodes(): Promise<HeadscaleNode[]> {
    const data = (await this.request("GET", "/api/v1/node")) as {
      nodes: unknown[];
    };
    return data.nodes.map((n) => headscaleNodeSchema.parse(n));
  }

  async getNode(nodeId: string): Promise<HeadscaleNode> {
    const data = (await this.request(
      "GET",
      `/api/v1/node/${encodeURIComponent(nodeId)}`,
    )) as { node: unknown };
    return headscaleNodeSchema.parse(data.node);
  }

  async deleteNode(nodeId: string): Promise<void> {
    await this.request(
      "DELETE",
      `/api/v1/node/${encodeURIComponent(nodeId)}`,
    );
  }

  async renameNode(nodeId: string, newName: string): Promise<HeadscaleNode> {
    const data = (await this.request(
      "POST",
      `/api/v1/node/${encodeURIComponent(nodeId)}/rename/${encodeURIComponent(newName)}`,
    )) as { node: unknown };
    return headscaleNodeSchema.parse(data.node);
  }

  async getPolicy(): Promise<object> {
    const data = (await this.request("GET", "/api/v1/policy")) as {
      policy: string;
      updatedAt?: string;
    };
    return JSON.parse(data.policy);
  }

  async setPolicy(policy: object): Promise<void> {
    await this.request("PUT", "/api/v1/policy", {
      policy: JSON.stringify(policy),
    });
  }

  async listRoutes(): Promise<HeadscaleRoute[]> {
    return (await this.listNodes()).flatMap(routesOfNode);
  }

  private async setRouteApproval(id: string, enable: boolean): Promise<void> {
    const parsed = parseRouteId(id);
    if (!parsed) throw new Error(`Invalid route id "${id}"`);
    const node = await this.getNode(parsed.nodeId);
    await this.request(
      "POST",
      `/api/v1/node/${encodeURIComponent(parsed.nodeId)}/approve_routes`,
      { routes: withRouteApproval(node.approvedRoutes ?? [], parsed.prefix, enable) },
    );
  }

  async enableRoute(id: string): Promise<void> {
    await this.setRouteApproval(id, true);
  }

  async disableRoute(id: string): Promise<void> {
    await this.setRouteApproval(id, false);
  }

  /** Headscale cannot delete a route while the device advertises it, so this withdraws approval. */
  async deleteRoute(id: string): Promise<void> {
    await this.setRouteApproval(id, false);
  }

  /** True when the API is reachable and accepts the key. */
  async healthcheck(): Promise<boolean> {
    try {
      await this.request("GET", "/api/v1/apikey");
      return true;
    } catch {
      return false;
    }
  }
}
