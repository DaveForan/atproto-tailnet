/**
 * @module orchestrator/gateway
 * Whether the coordinator serves named HTTPS services (ADR-0030). The
 * coordinator says so in its health answer; the answer is kept for a minute.
 */

import { config } from "../config.js";
import { CoordinatorApiClient } from "./coordinator-api.js";

const TTL_MS = 60_000;
let cached: { at: number; value: boolean } | null = null;

export async function httpsServicesAvailable(now: number = Date.now()): Promise<boolean> {
  if (!config.coordinatorUrl) return false;
  if (cached && now - cached.at < TTL_MS) return cached.value;
  const health = await new CoordinatorApiClient(config.coordinatorUrl, "", config.coordinatorApiKey).probeHealth(5_000);
  // An unreachable coordinator is not remembered: ask again next time
  if (!health) return cached?.value ?? false;
  cached = { at: now, value: health.gateway };
  return health.gateway;
}

/** For tests. */
export function resetHttpsServicesCache(): void {
  cached = null;
}
