/**
 * @module orchestrator/control-client
 * The one way to the coordinator's admin API. Call sites use this factory, not the client constructor.
 */

import { config } from "../config.js";
import { CoordinatorApiClient } from "./coordinator-api.js";

/**
 * Returns a coordinator client scoped to the tenant, or instance-level without one.
 * Errors: throws when the tenant has no coordinator id.
 */
export function getCoordinatorClient(
  tenant?: { coordinatorTenantId?: string | null } | null,
): CoordinatorApiClient {
  let tenantId = "";
  if (tenant) {
    if (!tenant.coordinatorTenantId) {
      throw new Error("Tenant has no coordinatorTenantId");
    }
    tenantId = tenant.coordinatorTenantId;
  }
  return new CoordinatorApiClient(config.coordinatorUrl, tenantId, config.coordinatorApiKey);
}
