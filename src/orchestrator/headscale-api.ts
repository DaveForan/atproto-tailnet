/**
 * @module orchestrator/headscale-api
 * REST client for the Headscale gRPC-gateway API (v1).
 * Used for all runtime operations after initial bootstrap (users, nodes,
 * pre-auth keys, ACL policy, health). Responses are Zod-validated.
 */

import { z } from "zod";

const headscaleNodeSchema = z.object({
  id: z.string(),
  machineKey: z.string().optional(),
  nodeKey: z.string().optional(),
  name: z.string(),
  givenName: z.string().optional(),
  // null for tagged nodes (which belong to no user) when fetched singly.
  user: z
    .object({
      id: z.string().optional(),
      name: z.string(),
    })
    .nullish(),
  ipAddresses: z.array(z.string()).optional(),
  online: z.boolean().optional(),
  // Headscale sends explicit nulls: `expiry` for nodes that never expire,
  // `lastSeen` for nodes that have not connected yet.
  lastSeen: z.string().nullish(),
  expiry: z.string().nullish(),
  /** Routes the device advertises (Headscale ≥ 0.26 reports routes on the node). */
  availableRoutes: z.array(z.string()).optional(),
  /** Advertised routes an admin or auto-approver has approved. */
  approvedRoutes: z.array(z.string()).optional(),
  /** Approved routes this node is currently the primary router for. */
  subnetRoutes: z.array(z.string()).optional(),
});

const headscaleUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string().optional(),
});

const headscalePreAuthKeySchema = z.object({
  id: z.string().optional(),
  key: z.string(),
  // An object since Headscale 0.26; older versions returned the user name.
  user: z.union([z.string(), headscaleUserSchema]).nullish(),
  reusable: z.boolean().optional(),
  ephemeral: z.boolean().optional(),
  used: z.boolean().optional(),
  expiration: z.string().optional(),
  createdAt: z.string().optional(),
});

/** A registered node (machine) in the tailnet. */
export type HeadscaleNode = z.infer<typeof headscaleNodeSchema>;
/** A Headscale user (namespace) that owns nodes. */
export type HeadscaleUser = z.infer<typeof headscaleUserSchema>;
/** A pre-authentication key used to register nodes without interactive login. */
export type HeadscalePreAuthKey = z.infer<typeof headscalePreAuthKeySchema>;
/**
 * An advertised route (subnet or exit node) from a device. Headscale no longer
 * has route objects — routes are properties of a node — so `id` is synthesized
 * from the node id and prefix (see {@link routeId}).
 */
export interface HeadscaleRoute {
  id: string;
  node: { id: string; name: string; givenName?: string; online?: boolean };
  prefix: string;
  advertised: boolean;
  enabled: boolean;
  isPrimary: boolean;
}

const EXIT_ROUTES = ["0.0.0.0/0", "::/0"];

/** URL- and attribute-safe id for one node's route: `<nodeId>-<base64url(prefix)>`. */
export function routeId(nodeId: string, prefix: string): string {
  return `${nodeId}-${Buffer.from(prefix).toString("base64url")}`;
}

/** Inverse of {@link routeId}; null when the id is malformed. */
export function parseRouteId(id: string): { nodeId: string; prefix: string } | null {
  const m = /^(\d+)-([A-Za-z0-9_-]+)$/.exec(id);
  if (!m) return null;
  const prefix = Buffer.from(m[2], "base64url").toString();
  if (routeId(m[1], prefix) !== id) return null;
  return { nodeId: m[1], prefix };
}

/** The routes of one node: everything it advertises plus anything still approved. */
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

/**
 * The approved-route list after approving or withdrawing one prefix. The two
 * exit routes (`0.0.0.0/0`, `::/0`) are one decision and always move together.
 */
export function withRouteApproval(
  approved: string[],
  prefix: string,
  enable: boolean,
): string[] {
  const affected = EXIT_ROUTES.includes(prefix) ? EXIT_ROUTES : [prefix];
  const rest = approved.filter((p) => !affected.includes(p));
  return enable ? [...rest, ...affected] : rest;
}

/**
 * Authenticated REST client for a single Headscale instance.
 * Connects to the container's localhost-bound port using the API key
 * generated during bootstrap.
 */
export class HeadscaleApiClient {
  private baseUrl: string;
  private apiKey: string;

  /** @param port - Localhost port the Headscale container is bound to. */
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

  /** Create a new user (namespace) in the Headscale instance. */
  async createUser(name: string): Promise<HeadscaleUser> {
    const data = (await this.request("POST", "/api/v1/user", {
      name,
    })) as { user: unknown };
    return headscaleUserSchema.parse(data.user);
  }

  /** List all users in the Headscale instance. */
  async listUsers(): Promise<HeadscaleUser[]> {
    const data = (await this.request("GET", "/api/v1/user")) as {
      users: unknown[];
    };
    return data.users.map((u) => headscaleUserSchema.parse(u));
  }

  /** Look a user up by exact name; null when there is no such user. */
  async getUserByName(name: string): Promise<HeadscaleUser | null> {
    const data = (await this.request(
      "GET",
      `/api/v1/user?name=${encodeURIComponent(name)}`,
    )) as { users?: unknown[] };
    const users = (data.users ?? []).map((u) => headscaleUserSchema.parse(u));
    return users.find((u) => u.name === name) ?? null;
  }

  /** Delete a user by name (the API addresses users by numeric id). No-op if absent. */
  async deleteUser(name: string): Promise<void> {
    const user = await this.getUserByName(name);
    if (!user) return;
    await this.request("DELETE", `/api/v1/user/${encodeURIComponent(user.id)}`);
  }

  /**
   * Create a pre-auth key for the named user. Defaults to single-use,
   * non-ephemeral, 24h expiry. The API takes the user's numeric id, so the name
   * is resolved first.
   */
  async createPreAuthKey(
    userName: string,
    opts?: { reusable?: boolean; ephemeral?: boolean; expirationSeconds?: number },
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
    })) as { preAuthKey: unknown };
    return headscalePreAuthKeySchema.parse(data.preAuthKey);
  }

  /** List all registered nodes across all users. */
  async listNodes(): Promise<HeadscaleNode[]> {
    const data = (await this.request("GET", "/api/v1/node")) as {
      nodes: unknown[];
    };
    return data.nodes.map((n) => headscaleNodeSchema.parse(n));
  }

  /** Get a single node by its Headscale-assigned ID. */
  async getNode(nodeId: string): Promise<HeadscaleNode> {
    const data = (await this.request(
      "GET",
      `/api/v1/node/${encodeURIComponent(nodeId)}`,
    )) as { node: unknown };
    return headscaleNodeSchema.parse(data.node);
  }

  /** Remove a node from the tailnet. */
  async deleteNode(nodeId: string): Promise<void> {
    await this.request(
      "DELETE",
      `/api/v1/node/${encodeURIComponent(nodeId)}`,
    );
  }

  /** Rename a node's given name. */
  async renameNode(nodeId: string, newName: string): Promise<HeadscaleNode> {
    const data = (await this.request(
      "POST",
      `/api/v1/node/${encodeURIComponent(nodeId)}/rename/${encodeURIComponent(newName)}`,
    )) as { node: unknown };
    return headscaleNodeSchema.parse(data.node);
  }

  /** Retrieve the current ACL policy document from the Headscale instance. */
  async getPolicy(): Promise<object> {
    const data = (await this.request("GET", "/api/v1/policy")) as {
      policy: string;
      updatedAt?: string;
    };
    return JSON.parse(data.policy);
  }

  /** Replace the ACL policy document (serialized as JSON string in the request body). */
  async setPolicy(policy: object): Promise<void> {
    await this.request("PUT", "/api/v1/policy", {
      policy: JSON.stringify(policy),
    });
  }

  /** List all routes across all nodes (derived from each node's route fields). */
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

  /** Enable (approve) an advertised route. */
  async enableRoute(id: string): Promise<void> {
    await this.setRouteApproval(id, true);
  }

  /** Disable (withdraw approval of) a route. */
  async disableRoute(id: string): Promise<void> {
    await this.setRouteApproval(id, false);
  }

  /**
   * Routes cannot be deleted in current Headscale — they exist for as long as
   * the device advertises them — so this withdraws approval.
   */
  async deleteRoute(id: string): Promise<void> {
    await this.setRouteApproval(id, false);
  }

  /** Returns true if the Headscale API is reachable and authenticated. */
  async healthcheck(): Promise<boolean> {
    try {
      await this.request("GET", "/api/v1/apikey");
      return true;
    } catch {
      return false;
    }
  }
}
