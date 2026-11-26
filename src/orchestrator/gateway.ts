/**
 * @module orchestrator/gateway
 * Whether the coordinator serves named HTTPS services (ADR-0030), and their
 * domain (ADR-0038). The coordinator says so in its health answer; the answer is kept for a minute.
 */

import { getCoordinatorClient } from "./control-client.js";

const TTL_MS = 60_000;
type Answer = { gateway: boolean; serviceDomain: string | null };
let cached: { at: number; value: Answer } | null = null;

async function ask(now: number): Promise<Answer> {
  const off: Answer = { gateway: false, serviceDomain: null };
  if (cached && now - cached.at < TTL_MS) return cached.value;
  const health = await getCoordinatorClient().probeHealth(5_000);
  // An unreachable coordinator is not remembered: ask again next time
  if (!health) return cached?.value ?? off;
  const value = { gateway: health.gateway && health.serviceDomain !== null, serviceDomain: health.serviceDomain };
  cached = { at: now, value };
  return value;
}

export async function httpsServicesAvailable(now: number = Date.now()): Promise<boolean> {
  return (await ask(now)).gateway;
}

/** The domain of HTTPS service names (`https://<name>.<domain>`), or null without a gateway. */
export async function httpsServiceDomain(now: number = Date.now()): Promise<string | null> {
  const answer = await ask(now);
  return answer.gateway ? answer.serviceDomain : null;
}

/** For tests. */
export function resetHttpsServicesCache(): void {
  cached = null;
}
