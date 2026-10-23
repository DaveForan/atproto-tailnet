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

export type HeadscaleNode = z.infer<typeof headscaleNodeSchema>;
export type HeadscaleUser = z.infer<typeof headscaleUserSchema>;
export type HeadscalePreAuthKey = z.infer<typeof headscalePreAuthKeySchema>;

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

  async deleteUser(name: string): Promise<void> {
    await this.request("DELETE", `/api/v1/user/${encodeURIComponent(name)}`);
  }

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

  async setPolicy(policy: object): Promise<void> {
    await this.request("PUT", "/api/v1/policy", {
      policy: JSON.stringify(policy),
    });
  }

  async healthcheck(): Promise<boolean> {
    try {
      await this.request("GET", "/api/v1/apikey");
      return true;
    } catch {
      return false;
    }
  }
}
