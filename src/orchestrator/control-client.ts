/**
 * @module orchestrator/control-client
 * Unified interface for control-plane operations. Abstracts whether the
 * backend is a per-tenant Headscale container or the shared Rust coordinator.
 *
 * All call sites should use {@link getControlClient} instead of directly
 * constructing HeadscaleApiClient or CoordinatorApiClient.
 */

import { config } from "../config.js";
import { HeadscaleApiClient } from "./headscale-api.js";
import { CoordinatorApiClient } from "./coordinator-api.js";
import type {
  HeadscaleNode,
  HeadscaleUser,
  HeadscalePreAuthKey,
  HeadscaleRoute,
} from "./headscale-api.js";

export type { HeadscaleNode, HeadscaleUser, HeadscalePreAuthKey, HeadscaleRoute };

export interface ControlClient {
  createUser(name: string): Promise<HeadscaleUser>;
  listUsers(): Promise<HeadscaleUser[]>;
  getUserByName(name: string): Promise<HeadscaleUser | null>;
  deleteUser(name: string): Promise<void>;
  createPreAuthKey(
    userName: string,
    opts?: { reusable?: boolean; ephemeral?: boolean; expirationSeconds?: number },
  ): Promise<HeadscalePreAuthKey>;
  createTaggedPreAuthKey(
    aclTags: string[],
    opts?: { expirationSeconds?: number },
  ): Promise<HeadscalePreAuthKey>;
  listNodes(): Promise<HeadscaleNode[]>;
  getNode(nodeId: string): Promise<HeadscaleNode>;
  deleteNode(nodeId: string): Promise<void>;
  renameNode(nodeId: string, newName: string): Promise<HeadscaleNode>;
  getPolicy(): Promise<object>;
  setPolicy(policy: object): Promise<void>;
  listRoutes(): Promise<HeadscaleRoute[]>;
  enableRoute(id: string): Promise<void>;
  disableRoute(id: string): Promise<void>;
  deleteRoute(id: string): Promise<void>;
  healthcheck(): Promise<boolean>;
}

/** True when the service is configured to use the Rust coordinator. */
export const useCoordinator = Boolean(config.coordinatorUrl);

/**
 * Return a control client for the given tenant. When COORDINATOR_URL is set,
 * returns a CoordinatorApiClient scoped to the tenant's coordinator-side ID;
 * otherwise returns a HeadscaleApiClient connected to the tenant's container.
 *
 * @param tenant - Must include `port`, `apiKey`, and `coordinatorTenantId`
 *   (the latter only required in coordinator mode).
 */
export function getControlClient(tenant: {
  port: number;
  apiKey: string;
  coordinatorTenantId?: string | null;
}): ControlClient {
  if (useCoordinator && config.coordinatorUrl) {
    if (!tenant.coordinatorTenantId) {
      throw new Error(
        "Tenant has no coordinatorTenantId but coordinator mode is active",
      );
    }
    return new CoordinatorApiClient(
      config.coordinatorUrl,
      tenant.coordinatorTenantId,
      config.coordinatorApiKey,
    );
  }
  return new HeadscaleApiClient(tenant.port, tenant.apiKey);
}
