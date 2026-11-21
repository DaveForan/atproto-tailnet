/**
 * @module orchestrator/coordinator-api
 * REST client for the Rust mesh coordinator's admin API (ADR-0023).
 * It keeps the method signatures of HeadscaleApiClient.
 */

import {
  routesOfNode,
  parseRouteId,
  withRouteApproval,
  type HeadscaleNode,
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

/** Coordinator keys without an expiry never expire, so we always send one. */
const DEFAULT_KEY_EXPIRY_SECONDS = 24 * 60 * 60;

const REQUEST_TIMEOUT_MS = 15_000;

const HEALTH_TIMEOUT_MS = 10_000;

/** The coordinator adds a node with this tag to tailnets with HTTPS services. */
export const GATEWAY_TAG = "tag:gateway";

/** A non-2xx answer from the coordinator admin API. */
export class CoordinatorError extends Error {
  constructor(
    readonly status: number,
    method: string,
    path: string,
    body: string,
  ) {
    super(`Coordinator API ${method} ${path} failed (${status}): ${body.slice(0, 200)}`);
    this.name = "CoordinatorError";
  }
}

export function isCoordinatorStatus(err: unknown, status: number): boolean {
  return err instanceof CoordinatorError && err.status === status;
}

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

/** `user` is the owner (our user id), or null for unowned and tagged nodes. */
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

/** A member's machine lock as the coordinator reports it. */
export interface OwnerLockView {
  locked: boolean;
  /** Nodes of the owner that the lock allows. */
  node_ids: number[];
  allow_one_until: string | null;
  refused: Array<{ at: string; hostname: string; os: string; fingerprint: string }>;
  /** Null means the system limit. */
  max_machines?: number | null;
  removed_nodes?: number;
}

export interface RefusedMachine {
  tenant_id: string;
  owner: string;
  at: string;
  hostname: string;
  os: string;
  fingerprint: string;
}

/** A pending interactive device sign-in (ADR-0032). */
export interface PendingDeviceAuth {
  hostname: string;
  os: string;
  fingerprint: string;
  pending: boolean;
  registered_tenant_id: string | null;
}

/**
 * Client for the shared coordinator. A tenant-scoped client names the
 * coordinator tenant on every call; an instance-level client has no tenant.
 */
export class CoordinatorApiClient {
  private readonly baseUrl: string;
  private readonly tenantId: string;
  private readonly apiKey: string | undefined;

  constructor(coordinatorUrl: string, tenantId: string, apiKey?: string) {
    this.baseUrl = coordinatorUrl.replace(/\/+$/, "");
    this.tenantId = tenantId;
    this.apiKey = apiKey;
  }

  /** Throws on an instance-level client, so a call never addresses an empty tenant. */
  private get tenant(): string {
    if (!this.tenantId) throw new Error("Tenant-scoped coordinator call on an instance-level client");
    return this.tenantId;
  }

  private tenantPath(suffix = ""): string {
    return `/api/tenants/${this.tenant}${suffix}`;
  }

  /** Errors: {@link CoordinatorError} on a non-2xx answer. */
  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new CoordinatorError(res.status, method, path, await res.text());
    if (res.status === 204) return null;
    return res.json();
  }


  /** Returns null when the coordinator is unreachable or unhealthy. */
  async probeHealth(timeoutMs = HEALTH_TIMEOUT_MS): Promise<{ bootId: string; gateway: boolean; serviceDomain: string | null } | null> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return null;
      const body = (await res.json().catch(() => ({}))) as { boot_id?: unknown; gateway?: unknown; service_domain?: unknown };
      return {
        bootId: typeof body.boot_id === "string" ? body.boot_id : "unknown",
        gateway: body.gateway === true,
        serviceDomain: typeof body.service_domain === "string" && body.service_domain ? body.service_domain : null,
      };
    } catch {
      return null;
    }
  }

  /** The boot id changes on every restart. */
  async probeBootId(timeoutMs = HEALTH_TIMEOUT_MS): Promise<string | null> {
    return (await this.probeHealth(timeoutMs))?.bootId ?? null;
  }

  async healthcheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }


  async getDeviceAuth(id: string): Promise<PendingDeviceAuth> {
    return (await this.request("GET", `/api/device-auth/${encodeURIComponent(id)}`)) as PendingDeviceAuth;
  }

  async approveDeviceAuth(id: string, coordinatorTenantId: string, owner: string): Promise<void> {
    await this.request("POST", `/api/device-auth/${encodeURIComponent(id)}/approve`, {
      tenant_id: coordinatorTenantId,
      owner,
    });
  }

  async denyDeviceAuth(id: string): Promise<void> {
    await this.request("POST", `/api/device-auth/${encodeURIComponent(id)}/deny`, {});
  }

  /** Covers all tenants, oldest first. */
  async listRefusedMachines(since?: Date): Promise<RefusedMachine[]> {
    const query = since ? `?since=${encodeURIComponent(since.toISOString())}` : "";
    const res = (await this.request("GET", `/api/owner-locks/refused${query}`)) as { refused?: RefusedMachine[] };
    return res.refused ?? [];
  }


  /** Instance-level call. Sub-collectives pass the parent's coordinator tenant id. */
  async createTenant(slug: string, parentId?: string | null): Promise<{ id: string }> {
    return (await this.request("POST", "/api/tenants", parentId ? { slug, parent_id: parentId } : { slug })) as {
      id: string;
    };
  }

  async deleteTenant(): Promise<void> {
    await this.request("DELETE", this.tenantPath());
  }

  /** Returns false on 404. Other failures throw. */
  async tenantExists(): Promise<boolean> {
    try {
      await this.request("GET", this.tenantPath());
      return true;
    } catch (err) {
      if (isCoordinatorStatus(err, 404)) return false;
      throw err;
    }
  }

  /** Operator suspension: no registration, no map streams, no new pre-auth keys. */
  async setSuspended(suspended: boolean): Promise<void> {
    await this.request("PUT", this.tenantPath("/suspended"), { suspended });
  }

  /** Null makes the tenant top-level. */
  async setParent(parentId: string | null): Promise<void> {
    await this.request("PUT", this.tenantPath("/parent"), { parent_id: parentId });
  }


  async setPosture(posture: string): Promise<void> {
    await this.request("PUT", this.tenantPath("/posture"), { posture });
  }

  /** Names shown in Tailscale clients (see coordinator-identity.ts). */
  async setIdentity(identity: {
    tailnet_name: string | null;
    users: Record<string, { login_name: string; display_name: string }>;
  }): Promise<void> {
    await this.request("PUT", this.tenantPath("/identity"), identity);
  }

  /** Device and service names (ADR-0028). */
  async setDns(dns: { base_domain: string | null; tailnet_label: string | null; upstream: string[]; records: unknown[] }): Promise<void> {
    await this.request("PUT", this.tenantPath("/dns"), dns);
  }

  /** Device access mode and rules (ADR-0036). The coordinator enforces them. */
  async setAccess(access: { mode: "open" | "member"; rules: unknown[] }): Promise<void> {
    await this.request("PUT", this.tenantPath("/access"), access);
  }

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
    await this.request("PUT", this.tenantPath("/derp"), { regions: coordRegions, include_default: includeDefault });
  }


  async getPolicy(): Promise<object> {
    return (await this.request("GET", this.tenantPath("/acl"))) as object;
  }

  async setPolicy(policy: object): Promise<void> {
    await this.request("POST", this.tenantPath("/acl"), policy);
  }

  async getHeadscalePolicy(): Promise<ReturnType<typeof coordinatorToHeadscalePolicy>> {
    return coordinatorToHeadscalePolicy(await this.request("GET", this.tenantPath("/acl")));
  }

  /** Errors: throws `AclTranslationError` when the coordinator cannot represent the policy. */
  async setHeadscalePolicy(policy: HeadscaleAclPolicy): Promise<void> {
    await this.request("POST", this.tenantPath("/acl"), headscaleToCoordinatorPolicy(policy));
  }


  async getAutoApprovers(): Promise<AutoApproversConfig> {
    const data = (await this.request("GET", this.tenantPath("/auto-approvers"))) as Partial<AutoApproversConfig> | null;
    return { routes: data?.routes ?? {}, exit_node: data?.exit_node ?? [] };
  }

  /** The caller stores them in `tenants.coordinatorAutoApprovers`. */
  async setAutoApprovers(aa: AutoApproversConfig): Promise<void> {
    await this.request("PUT", this.tenantPath("/auto-approvers"), { routes: aa.routes ?? {}, exit_node: aa.exit_node ?? [] });
  }


  /** Nodes that register with the key get `owner`. This is device ownership in coordinator mode. */
  async createPreAuthKey(_userName: string, opts?: PreAuthKeyOptions): Promise<HeadscalePreAuthKey & { id: string }> {
    const data = (await this.request("POST", "/api/preauth-keys", {
      tenant_id: this.tenant,
      reusable: opts?.reusable ?? false,
      ephemeral: opts?.ephemeral ?? false,
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

  /** Nodes that register with the key belong to no member. */
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

  /** Returns the prefix only, never the secret. */
  async listPreAuthKeys(): Promise<ControlPreAuthKeyInfo[]> {
    const data = (await this.request("GET", this.tenantPath("/preauth-keys"))) as {
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

  /** A 404 (already gone, or not in this tenant) counts as done. */
  async revokePreAuthKey(keyId: string): Promise<void> {
    try {
      await this.request("DELETE", this.tenantPath(`/preauth-keys/${encodeURIComponent(keyId)}`));
    } catch (err) {
      if (isCoordinatorStatus(err, 404)) return;
      throw err;
    }
  }

  /** Returns the number of revoked keys. */
  async revokePreAuthKeysByOwner(owner: string): Promise<number> {
    const data = (await this.request("DELETE", this.tenantPath(`/preauth-keys?owner=${encodeURIComponent(owner)}`))) as {
      revoked?: number;
    } | null;
    return data?.revoked ?? 0;
  }


  async listNodes(): Promise<HeadscaleNode[]> {
    const data = (await this.request("GET", this.tenantPath("/nodes"))) as { nodes: CoordinatorNode[] };
    // The gateway (ADR-0029) belongs to the instance, not to a member
    return data.nodes.filter((n) => !(n.tags ?? []).includes(GATEWAY_TAG)).map(toHeadscaleNode);
  }

  async getNode(nodeId: string): Promise<HeadscaleNode> {
    const tenant = this.tenant;
    const data = (await this.request("GET", `/api/nodes/${encodeURIComponent(nodeId)}`)) as CoordinatorNode;
    if (data.tenant_id !== tenant) throw new Error("Node belongs to different tenant");
    return toHeadscaleNode(data);
  }

  async deleteNode(nodeId: string): Promise<void> {
    await this.request("DELETE", `/api/nodes/${encodeURIComponent(nodeId)}?tenant_id=${this.tenant}`);
  }

  /** Ends the owner's map streams and returns the number of deleted nodes. */
  async deleteNodesByOwner(owner: string): Promise<number> {
    const data = (await this.request("DELETE", this.tenantPath(`/nodes?owner=${encodeURIComponent(owner)}`))) as {
      deleted?: number;
    } | null;
    return data?.deleted ?? 0;
  }

  async renameNode(nodeId: string, newName: string): Promise<HeadscaleNode> {
    const data = (await this.request("POST", `/api/nodes/${encodeURIComponent(nodeId)}/name?tenant_id=${this.tenant}`, {
      name: newName,
    })) as CoordinatorNode;
    return toHeadscaleNode(data);
  }


  /** Uses the same route ids as Headscale mode. */
  async listRoutes(): Promise<HeadscaleRoute[]> {
    return (await this.listNodes()).flatMap(routesOfNode);
  }

  private async setRouteApproval(id: string, enable: boolean): Promise<void> {
    const parsed = parseRouteId(id);
    if (!parsed) throw new Error(`Invalid route id "${id}"`);
    const node = await this.getNode(parsed.nodeId);
    const advertised = node.availableRoutes ?? [];
    // The coordinator rejects approvals that aren't advertised (400)
    const approved = withRouteApproval(node.approvedRoutes ?? [], parsed.prefix, enable).filter((p) =>
      advertised.includes(p),
    );
    await this.request("POST", this.tenantPath(`/nodes/${encodeURIComponent(parsed.nodeId)}/routes`), { approved });
  }

  async enableRoute(id: string): Promise<void> {
    await this.setRouteApproval(id, true);
  }

  async disableRoute(id: string): Promise<void> {
    await this.setRouteApproval(id, false);
  }

  /** A route exists while advertised, so this withdraws approval. */
  async deleteRoute(id: string): Promise<void> {
    await this.setRouteApproval(id, false);
  }


  private ownerLockPath(owner: string): string {
    return this.tenantPath(`/owner-locks/${encodeURIComponent(owner)}`);
  }

  async getOwnerLock(owner: string): Promise<OwnerLockView> {
    return (await this.request("GET", this.ownerLockPath(owner))) as OwnerLockView;
  }

  /** The coordinator removes the owner's other nodes (ADR-0035). */
  async setOwnerLock(owner: string, nodeIds: number[], maxMachines?: number): Promise<OwnerLockView> {
    const body = { node_ids: nodeIds, ...(maxMachines ? { max_machines: maxMachines } : {}) };
    return (await this.request("PUT", this.ownerLockPath(owner), body)) as OwnerLockView;
  }

  /** Opens the one-new-machine window. Returns null without a lock and "full" at the limit. */
  async allowOneMachine(owner: string, seconds: number): Promise<OwnerLockView | null | "full"> {
    try {
      return (await this.request("POST", `${this.ownerLockPath(owner)}/allow-one`, { seconds })) as OwnerLockView;
    } catch (err) {
      if (isCoordinatorStatus(err, 404)) return null;
      if (isCoordinatorStatus(err, 409)) return "full";
      throw err;
    }
  }

  async deleteOwnerLock(owner: string): Promise<void> {
    await this.request("DELETE", this.ownerLockPath(owner));
  }
}
