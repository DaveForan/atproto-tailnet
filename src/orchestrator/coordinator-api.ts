/**
 * @module orchestrator/coordinator-api
 * REST client for the Rust mesh coordinator (ADR-0023).
 * Drop-in replacement for HeadscaleApiClient — same method signatures,
 * backed by the coordinator's admin API instead of Headscale's gRPC-gateway.
 */

import {
  routesOfNode,
  parseRouteId,
  withRouteApproval,
  type HeadscaleNode,
  type HeadscaleUser,
  type HeadscalePreAuthKey,
  type HeadscaleRoute,
  type PreAuthKeyOptions,
  type ControlPreAuthKeyInfo,
  type AutoApproversConfig,
} from "./headscale-api.js";
import {
  headscaleToCoordinatorPolicy,
  coordinatorToHeadscalePolicy,
  type HeadscaleAclPolicy,
} from "./coordinator-acl.js";

/** Default key lifetime when the caller gives none (coordinator keys otherwise never expire). */
const DEFAULT_KEY_EXPIRY_SECONDS = 24 * 60 * 60;

/** Node summary as returned by the coordinator admin API. */
interface CoordinatorNode {
  id: number;
  tenant_id: string;
  ipv4: string;
  ipv6?: string | null;
  stable_id: string;
  hostname: string;
  online: boolean;
  owner?: string | null;
  tags?: string[];
  ephemeral?: boolean;
  advertised_routes?: string[];
  approved_routes?: string[];
}

/**
 * Map a coordinator node to the Headscale node shape. The node's `user` is
 * derived from its owner (our user id) — `null` for unowned/tagged nodes.
 */
export function toHeadscaleNode(n: CoordinatorNode): HeadscaleNode {
  const owner = n.owner ?? null;
  return {
    id: String(n.id),
    name: n.hostname,
    givenName: n.hostname,
    ipAddresses: [n.ipv4, ...(n.ipv6 ? [n.ipv6] : [])],
    online: n.online,
    lastSeen: null,
    expiry: null,
    user: owner ? { id: owner, name: owner } : null,
    machineKey: n.stable_id ? `mkey:${n.stable_id}` : undefined,
    availableRoutes: n.advertised_routes ?? [],
    approvedRoutes: n.approved_routes ?? [],
    subnetRoutes: n.approved_routes ?? [],
  };
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && err.message.includes("failed (404)");
}

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

  /**
   * Operator suspension (persisted by the coordinator): a suspended tenant's
   * nodes cannot register or map, live map streams end, new pre-auth keys are
   * refused.
   */
  async setSuspended(suspended: boolean): Promise<void> {
    await this.request("PUT", `/api/tenants/${this.tenantId}/suspended`, { suspended });
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

  /**
   * Create a pre-auth key. `owner` (our user id) is copied onto nodes that
   * register with it, which is what makes per-member device ownership,
   * delete-by-owner and kick work in coordinator mode. Returns the Headscale
   * shape plus the coordinator's non-secret key `id`.
   */
  async createPreAuthKey(
    _userName: string,
    opts?: PreAuthKeyOptions,
  ): Promise<HeadscalePreAuthKey & { id: string }> {
    const data = (await this.request("POST", "/api/preauth-keys", {
      tenant_id: this.tenantId,
      reusable: opts?.reusable ?? false,
      ephemeral: opts?.ephemeral ?? false,
      // Keys without an expiry never expire on the coordinator — always send one.
      expiration_seconds: opts?.expirationSeconds ?? DEFAULT_KEY_EXPIRY_SECONDS,
      ...(opts?.owner ? { owner: opts.owner } : {}),
      ...(opts?.tags?.length ? { tags: opts.tags } : {}),
    })) as { key: string; id: string; tenant_id: string; expires_at?: string | null };

    return {
      id: data.id,
      key: data.key,
      reusable: opts?.reusable ?? false,
      ephemeral: opts?.ephemeral ?? false,
      used: false,
      ...(data.expires_at ? { expiration: data.expires_at } : {}),
    };
  }

  /** Create a key whose nodes carry the given ACL tags and belong to no member. */
  async createTaggedPreAuthKey(
    aclTags: string[],
    opts?: { expirationSeconds?: number; ephemeral?: boolean },
  ): Promise<HeadscalePreAuthKey & { id: string }> {
    return this.createPreAuthKey("tagged", {
      reusable: false,
      ephemeral: opts?.ephemeral ?? false,
      expirationSeconds: opts?.expirationSeconds ?? 300,
      tags: aclTags,
    });
  }

  /** List the tenant's pre-auth keys (prefix only, never the secret). */
  async listPreAuthKeys(): Promise<ControlPreAuthKeyInfo[]> {
    const data = (await this.request(
      "GET",
      `/api/tenants/${this.tenantId}/preauth-keys`,
    )) as {
      keys: Array<{
        id: string;
        prefix: string;
        owner: string | null;
        tags?: string[];
        reusable: boolean;
        ephemeral: boolean;
        used: boolean;
        expires_at: string | null;
        created_at: string;
        revoked: boolean;
      }>;
    };
    return (data.keys ?? []).map((k) => ({
      id: k.id,
      prefix: k.prefix,
      owner: k.owner ?? null,
      tags: k.tags ?? [],
      reusable: k.reusable,
      ephemeral: k.ephemeral,
      used: k.used,
      expiresAt: k.expires_at ?? null,
      createdAt: k.created_at ?? null,
      revoked: k.revoked,
    }));
  }

  /** Revoke one key. Treats 404 (already gone / not in tenant) as done. */
  async revokePreAuthKey(keyId: string): Promise<void> {
    try {
      await this.request(
        "DELETE",
        `/api/tenants/${this.tenantId}/preauth-keys/${encodeURIComponent(keyId)}`,
      );
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
  }

  /** Revoke every key issued to `owner`; returns how many were revoked. */
  async revokePreAuthKeysByOwner(owner: string): Promise<number> {
    const data = (await this.request(
      "DELETE",
      `/api/tenants/${this.tenantId}/preauth-keys?owner=${encodeURIComponent(owner)}`,
    )) as { revoked?: number } | null;
    return data?.revoked ?? 0;
  }

  // ── Node operations ──

  async listNodes(): Promise<HeadscaleNode[]> {
    const data = (await this.request(
      "GET",
      `/api/tenants/${this.tenantId}/nodes`,
    )) as { nodes: CoordinatorNode[] };
    return data.nodes.map(toHeadscaleNode);
  }

  async getNode(nodeId: string): Promise<HeadscaleNode> {
    const data = (await this.request(
      "GET",
      `/api/nodes/${encodeURIComponent(nodeId)}`,
    )) as CoordinatorNode;
    if (data.tenant_id !== this.tenantId) {
      throw new Error("Node belongs to different tenant");
    }
    return toHeadscaleNode(data);
  }

  async deleteNode(nodeId: string): Promise<void> {
    await this.request(
      "DELETE",
      `/api/nodes/${encodeURIComponent(nodeId)}?tenant_id=${this.tenantId}`,
    );
  }

  /** Delete every node owned by `owner` (ends their map streams); returns the count. */
  async deleteNodesByOwner(owner: string): Promise<number> {
    const data = (await this.request(
      "DELETE",
      `/api/tenants/${this.tenantId}/nodes?owner=${encodeURIComponent(owner)}`,
    )) as { deleted?: number } | null;
    return data?.deleted ?? 0;
  }

  async renameNode(nodeId: string, newName: string): Promise<HeadscaleNode> {
    const data = (await this.request(
      "POST",
      `/api/nodes/${encodeURIComponent(nodeId)}/name?tenant_id=${this.tenantId}`,
      { name: newName },
    )) as CoordinatorNode;
    return toHeadscaleNode(data);
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
      if (isNotFound(err)) return false;
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

  /**
   * Every node's advertised/approved routes, with the same synthesized route
   * ids as Headscale mode (`routeId(nodeId, prefix)`).
   */
  async listRoutes(): Promise<HeadscaleRoute[]> {
    return (await this.listNodes()).flatMap(routesOfNode);
  }

  private async setRouteApproval(id: string, enable: boolean): Promise<void> {
    const parsed = parseRouteId(id);
    if (!parsed) throw new Error(`Invalid route id "${id}"`);
    const node = await this.getNode(parsed.nodeId);
    const advertised = node.availableRoutes ?? [];
    // The coordinator rejects approvals that aren't advertised (400)
    const approved = withRouteApproval(node.approvedRoutes ?? [], parsed.prefix, enable)
      .filter((p) => advertised.includes(p));
    await this.request(
      "POST",
      `/api/tenants/${this.tenantId}/nodes/${encodeURIComponent(parsed.nodeId)}/routes`,
      { approved },
    );
  }

  async enableRoute(id: string): Promise<void> {
    await this.setRouteApproval(id, true);
  }

  async disableRoute(id: string): Promise<void> {
    await this.setRouteApproval(id, false);
  }

  /** Routes exist while advertised; "delete" withdraws approval (as in Headscale mode). */
  async deleteRoute(id: string): Promise<void> {
    await this.setRouteApproval(id, false);
  }

  // ── Auto-approvers ──

  async getAutoApprovers(): Promise<AutoApproversConfig> {
    const data = (await this.request(
      "GET",
      `/api/tenants/${this.tenantId}/auto-approvers`,
    )) as Partial<AutoApproversConfig> | null;
    return { routes: data?.routes ?? {}, exit_node: data?.exit_node ?? [] };
  }

  /**
   * Store the auto-approvers in the DB (the source of truth, replayed by the
   * monitor after a coordinator restart) and push them to the coordinator.
   */
  async setAutoApprovers(aa: AutoApproversConfig): Promise<void> {
    const value: AutoApproversConfig = { routes: aa.routes ?? {}, exit_node: aa.exit_node ?? [] };
    const [{ db }, { tenants }, { eq }] = await Promise.all([
      import("../db/index.js"),
      import("../db/schema.js"),
      import("drizzle-orm"),
    ]);
    await db
      .update(tenants)
      .set({ coordinatorAutoApprovers: value, updatedAt: new Date() })
      .where(eq(tenants.coordinatorTenantId, this.tenantId));
    await this.pushAutoApprovers(value);
  }

  /** Device and service names (ADR-0028); stored by the coordinator and sent to devices. */
  async setDns(dns: { base_domain: string | null; tailnet_label: string | null; upstream: string[]; records: unknown[] }): Promise<void> {
    await this.request("PUT", `/api/tenants/${this.tenantId}/dns`, dns);
  }

  /** Device access mode and rules (ADR-0036); stored and enforced by the coordinator. */
  async setAccess(access: { mode: "open" | "member"; rules: unknown[] }): Promise<void> {
    await this.request("PUT", `/api/tenants/${this.tenantId}/access`, access);
  }

  /** Tailnet + member names shown in Tailscale clients (see coordinator-identity.ts). */
  async setIdentity(identity: {
    tailnet_name: string | null;
    users: Record<string, { login_name: string; display_name: string }>;
  }): Promise<void> {
    await this.request("PUT", `/api/tenants/${this.tenantId}/identity`, identity);
  }

  /** Push auto-approvers without persisting (used by the monitor's replay). */
  async pushAutoApprovers(aa: AutoApproversConfig): Promise<void> {
    await this.request("PUT", `/api/tenants/${this.tenantId}/auto-approvers`, aa);
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
