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
  user: z
    .object({
      id: z.string().optional(),
      name: z.string(),
    })
    .optional(),
  ipAddresses: z.array(z.string()).optional(),
  online: z.boolean().optional(),
  lastSeen: z.string().optional(),
  expiry: z.string().optional(),
});

const headscaleUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string().optional(),
});

const headscalePreAuthKeySchema = z.object({
  id: z.string().optional(),
  key: z.string(),
  user: z.string().optional(),
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

  /** Delete a user by name. */
  async deleteUser(name: string): Promise<void> {
    await this.request("DELETE", `/api/v1/user/${encodeURIComponent(name)}`);
  }

  /** Create a pre-auth key for a user. Defaults to single-use, non-ephemeral, 24h expiry. */
  async createPreAuthKey(
    user: string,
    opts?: { reusable?: boolean; ephemeral?: boolean; expirationSeconds?: number },
  ): Promise<HeadscalePreAuthKey> {
    const expiration = opts?.expirationSeconds
      ? new Date(Date.now() + opts.expirationSeconds * 1000).toISOString()
      : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const data = (await this.request("POST", "/api/v1/preauthkey", {
      user,
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
