/**
 * @module orchestrator/coordinator-api
 * REST client for the Rust mesh coordinator (ADR-0023).
 * Drop-in replacement for HeadscaleApiClient — same method signatures,
 * backed by the coordinator's admin API instead of Headscale's gRPC-gateway.
 */

import type {
  HeadscaleNode,
  HeadscaleUser,
  HeadscalePreAuthKey,
  HeadscaleRoute,
} from "./headscale-api.js";
import {
  headscaleToCoordinatorPolicy,
  coordinatorToHeadscalePolicy,
  type HeadscaleAclPolicy,
} from "./coordinator-acl.js";

/**
 * Client for a single tenant's operations against the shared coordinator.
 * Unlike HeadscaleApiClient (one Headscale container per tenant), every
 * CoordinatorApiClient talks to the same coordinator process; the tenant
 * is identified by `tenantId` and scoped server-side.
 */
export class CoordinatorApiClient {
  private baseUrl: string;
  private tenantId: string;
  private apiKey: string | undefined;

  constructor(coordinatorUrl: string, tenantId: string, apiKey?: string) {
    this.baseUrl = coordinatorUrl.replace(/\/+$/, "");
    this.tenantId = tenantId;
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
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Coordinator API ${method} ${path} failed (${res.status}): ${text.slice(0, 200)}`,
      );
    }

    if (res.status === 204) return null;
    return res.json();
  }

  // ── Tenant lifecycle ──

  async deleteTenant(): Promise<void> {
    await this.request("DELETE", `/api/tenants/${this.tenantId}`);
  }

  // ── User operations (no-op in coordinator — tenants replace users) ──

  async createUser(name: string): Promise<HeadscaleUser> {
    const syntheticId = Buffer.from(name).toString("base64url");
    return { id: syntheticId, name };
  }

  async listUsers(): Promise<HeadscaleUser[]> {
    return [{ id: "1", name: "mesh-user" }];
  }

  async getUserByName(name: string): Promise<HeadscaleUser | null> {
    return { id: "1", name };
  }

  async deleteUser(_name: string): Promise<void> {
    // No-op: coordinator doesn't have per-user namespaces
  }

  // ── Pre-auth keys ──

  async createPreAuthKey(
    _userName: string,
    opts?: { reusable?: boolean; ephemeral?: boolean; expirationSeconds?: number },
  ): Promise<HeadscalePreAuthKey> {
    const data = (await this.request("POST", "/api/preauth-keys", {
      tenant_id: this.tenantId,
      reusable: opts?.reusable ?? false,
      ephemeral: opts?.ephemeral ?? false,
      expiration_seconds: opts?.expirationSeconds,
    })) as { key: string; tenant_id: string };

    return {
      key: data.key,
      reusable: opts?.reusable ?? false,
      ephemeral: opts?.ephemeral ?? false,
      used: false,
    };
  }

  async createTaggedPreAuthKey(
    _aclTags: string[],
    opts?: { expirationSeconds?: number },
  ): Promise<HeadscalePreAuthKey> {
    return this.createPreAuthKey("tagged", { reusable: false, ...opts });
  }

  // ── Node operations ──

  async listNodes(): Promise<HeadscaleNode[]> {
    const data = (await this.request(
      "GET",
      `/api/tenants/${this.tenantId}/nodes`,
    )) as {
      nodes: Array<{
        id: number;
        tenant_id: string;
        ipv4: string;
        stable_id: string;
        hostname: string;
        online: boolean;
      }>;
    };

    return data.nodes.map((n) => ({
      id: String(n.id),
      name: n.hostname,
      givenName: n.hostname,
      ipAddresses: [n.ipv4],
      online: n.online,
      lastSeen: null,
      expiry: null,
      user: { id: "1", name: "coordinator" },
      machineKey: n.stable_id ? `mkey:${n.stable_id}` : undefined,
    }));
  }

  async getNode(nodeId: string): Promise<HeadscaleNode> {
    const data = (await this.request("GET", `/api/nodes/${nodeId}`)) as {
      id: number;
      tenant_id: string;
      ipv4: string;
      stable_id: string;
      hostname: string;
      online: boolean;
    };
    if (data.tenant_id !== this.tenantId) {
      throw new Error("Node belongs to different tenant");
    }
    return {
      id: String(data.id),
      name: data.hostname,
      givenName: data.hostname,
      ipAddresses: [data.ipv4],
      online: data.online,
      lastSeen: null,
      expiry: null,
      user: { id: "1", name: "coordinator" },
      machineKey: data.stable_id ? `mkey:${data.stable_id}` : undefined,
    };
  }

  async deleteNode(nodeId: string): Promise<void> {
    await this.request(
      "DELETE",
      `/api/nodes/${nodeId}?tenant_id=${this.tenantId}`,
    );
  }

  async renameNode(nodeId: string, newName: string): Promise<HeadscaleNode> {
    const data = (await this.request(
      "POST",
      `/api/nodes/${nodeId}/name?tenant_id=${this.tenantId}`,
      { name: newName },
    )) as {
      id: number;
      tenant_id: string;
      ipv4: string;
      stable_id: string;
      hostname: string;
      online: boolean;
    };
    return {
      id: String(data.id),
      name: data.hostname,
      givenName: data.hostname,
      ipAddresses: [data.ipv4],
      online: data.online,
      lastSeen: null,
      expiry: null,
      user: { id: "1", name: "coordinator" },
      machineKey: data.stable_id ? `mkey:${data.stable_id}` : undefined,
    };
  }

  // ── ACL policy ──

  async getPolicy(): Promise<object> {
    const data = await this.request(
      "GET",
      `/api/tenants/${this.tenantId}/acl`,
    );
    return data as object;
  }

  async setPolicy(policy: object): Promise<void> {
    await this.request("POST", `/api/tenants/${this.tenantId}/acl`, policy);
  }

  /**
   * Pushes a Headscale-format policy after translating it to the
   * coordinator's `{default_deny, rules}` model.
   * @throws {AclTranslationError} if the policy can't be expressed faithfully.
   */
  async setHeadscalePolicy(policy: HeadscaleAclPolicy): Promise<void> {
    const translated = headscaleToCoordinatorPolicy(policy);
    await this.request("POST", `/api/tenants/${this.tenantId}/acl`, translated);
  }

  /**
   * Bounded health probe for the shared coordinator. Returns the coordinator's
   * per-process boot id (changes on every restart), or null when unhealthy.
   */
  async probeBootId(timeoutMs = 10_000): Promise<string | null> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      const body = (await res.json().catch(() => ({}))) as { boot_id?: unknown };
      return typeof body.boot_id === "string" ? body.boot_id : "unknown";
    } catch {
      return null;
    }
  }

  /**
   * True if the coordinator knows this tenant (`GET /api/tenants/{id}`),
   * false on 404. Other failures throw.
   */
  async tenantExists(): Promise<boolean> {
    try {
      await this.request("GET", `/api/tenants/${this.tenantId}`);
      return true;
    } catch (err) {
      if (err instanceof Error && err.message.includes("failed (404)")) return false;
      throw err;
    }
  }

  /** Reads the tenant's coordinator policy rendered in Headscale format. */
  async getHeadscalePolicy(): Promise<ReturnType<typeof coordinatorToHeadscalePolicy>> {
    const raw = await this.request("GET", `/api/tenants/${this.tenantId}/acl`);
    return coordinatorToHeadscalePolicy(raw);
  }

  // ── DERP ──

  async setDerp(
    regions: Array<{
      regionId: number;
      regionCode: string;
      regionName: string;
      nodes: Array<{ name: string; hostname: string; stunPort?: number; derpPort?: number }>;
    }>,
    includeDefault: boolean,
  ): Promise<void> {
    const coordRegions: Record<string, unknown> = {};
    for (const r of regions) {
      coordRegions[String(r.regionId)] = {
        RegionID: r.regionId,
        RegionCode: r.regionCode,
        RegionName: r.regionName,
        Nodes: r.nodes.map((n) => ({
          Name: n.name,
          RegionID: r.regionId,
          HostName: n.hostname,
          STUNPort: n.stunPort ?? 3478,
          DERPPort: n.derpPort ?? 443,
        })),
      };
    }
    await this.request("PUT", `/api/tenants/${this.tenantId}/derp`, {
      regions: coordRegions,
      include_default: includeDefault,
    });
  }

  // ── Posture ──

  async setPosture(posture: string): Promise<void> {
    await this.request("PUT", `/api/tenants/${this.tenantId}/posture`, {
      posture,
    });
  }

  // ── Routes ──

  async listRoutes(): Promise<HeadscaleRoute[]> {
    const data = (await this.request(
      "GET",
      `/api/tenants/${this.tenantId}/routes`,
    )) as {
      own_routes: string[];
      aggregated_child_routes: Array<{
        tenant_id: string;
        slug: string;
        routes: string[];
        node_count: number;
      }>;
    };

    const routes: HeadscaleRoute[] = [];
    for (const prefix of data.own_routes) {
      routes.push({
        id: `coord-${Buffer.from(prefix).toString("base64url")}`,
        node: { id: "0", name: "coordinator", online: true },
        prefix,
        advertised: true,
        enabled: true,
        isPrimary: true,
      });
    }
    return routes;
  }

  async enableRoute(_id: string): Promise<void> {
    throw new Error("Route management is not yet supported in coordinator mode");
  }

  async disableRoute(_id: string): Promise<void> {
    throw new Error("Route management is not yet supported in coordinator mode");
  }

  async deleteRoute(_id: string): Promise<void> {
    throw new Error("Route management is not yet supported in coordinator mode");
  }

  // ── Health ──

  async healthcheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        headers: this.apiKey
          ? { Authorization: `Bearer ${this.apiKey}` }
          : {},
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
