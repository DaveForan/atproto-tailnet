/**
 * @module orchestrator/control-client
 * One control-plane interface for per-tenant Headscale and the shared Rust coordinator.
 * Call sites use these factories, not the API client constructors.
 */

import { config } from "../config.js";
import { HeadscaleApiClient } from "./headscale-api.js";
import { CoordinatorApiClient } from "./coordinator-api.js";
import type {
  HeadscaleNode,
  HeadscaleUser,
  HeadscalePreAuthKey,
  HeadscaleRoute,
  PreAuthKeyOptions,
  ControlPreAuthKeyInfo,
  AutoApproversConfig,
} from "./headscale-api.js";

export type {
  HeadscaleNode,
  HeadscaleUser,
  HeadscalePreAuthKey,
  HeadscaleRoute,
  PreAuthKeyOptions,
  ControlPreAuthKeyInfo,
  AutoApproversConfig,
};

export interface ControlClient {
  /** Headscale namespaces; the coordinator has none and leaves these out. */
  createUser?(name: string): Promise<HeadscaleUser>;
  listUsers?(): Promise<HeadscaleUser[]>;
  deleteUser?(name: string): Promise<void>;
  /** `owner` is recorded by the coordinator (node ownership); Headscale ignores it. */
  createPreAuthKey(
    userName: string,
    opts?: PreAuthKeyOptions,
  ): Promise<HeadscalePreAuthKey>;
  createTaggedPreAuthKey(
    aclTags: string[],
    opts?: { expirationSeconds?: number; ephemeral?: boolean },
  ): Promise<HeadscalePreAuthKey>;
  listPreAuthKeys(): Promise<ControlPreAuthKeyInfo[]>;
  getAutoApprovers(): Promise<AutoApproversConfig>;
  setAutoApprovers(aa: AutoApproversConfig): Promise<void>;
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

export const useCoordinator = Boolean(config.coordinatorUrl);

/** Returns the coordinator client when `COORDINATOR_URL` is set, else the tenant's Headscale client. */
export function getControlClient(tenant: {
  port: number;
  apiKey: string;
  coordinatorTenantId?: string | null;
}): ControlClient {
  if (useCoordinator && config.coordinatorUrl) {
    return getCoordinatorClient(tenant);
  }
  return new HeadscaleApiClient(tenant.port, tenant.apiKey);
}

/**
 * Returns a coordinator client scoped to the tenant, or instance-level without one.
 * Errors: throws outside coordinator mode, or when the tenant has no coordinator id.
 */
export function getCoordinatorClient(
  tenant?: { coordinatorTenantId?: string | null } | null,
): CoordinatorApiClient {
  if (!useCoordinator || !config.coordinatorUrl) {
    throw new Error("Coordinator client requested but coordinator mode is not active (COORDINATOR_URL unset)");
  }
  let tenantId = "";
  if (tenant) {
    if (!tenant.coordinatorTenantId) {
      throw new Error("Tenant has no coordinatorTenantId but coordinator mode is active");
    }
    tenantId = tenant.coordinatorTenantId;
  }
  return new CoordinatorApiClient(config.coordinatorUrl, tenantId, config.coordinatorApiKey);
}
