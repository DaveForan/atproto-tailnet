/**
 * @module federation/scoping
 * Federation scope model — local/regional/global tiers (ADR-0015).
 */

import { z } from "zod";

export type FederationScope = "local" | "regional" | "global";

export const SCOPE_PRIORITY: Record<FederationScope, number> = {
  local: 300,
  regional: 200,
  global: 100,
};

export interface ScopePolicyConfig {
  autoAccept: boolean;
  verification: "standard" | "strict";
}

export interface ScopeDeclaration {
  scopes: FederationScope[];
  region?: string; // UN M49 code
  coordinates?: [number, number]; // [lat, lon]
  scopePolicies: Partial<Record<FederationScope, ScopePolicyConfig>>;
}

export const scopeDeclarationSchema = z.object({
  scopes: z.array(z.enum(["local", "regional", "global"])).min(1).max(3),
  region: z.string().regex(/^\d{3}$/, "Must be UN M49 3-digit code").optional(),
  coordinates: z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)]).optional(),
  scopePolicies: z.record(
    z.enum(["local", "regional", "global"]),
    z.object({
      autoAccept: z.boolean(),
      verification: z.enum(["standard", "strict"]),
    }),
  ).optional(),
});

export function negotiateScope(
  localScopes: FederationScope[],
  remoteScopes: FederationScope[],
): FederationScope | null {
  const narrowest: FederationScope[] = ["local", "regional", "global"];
  for (const scope of narrowest) {
    if (localScopes.includes(scope) && remoteScopes.includes(scope)) {
      return scope;
    }
  }
  return null;
}

export function conservativeScope(
  localScope: FederationScope,
  remoteScope: FederationScope,
): FederationScope {
  const localPri = SCOPE_PRIORITY[localScope];
  const remotePri = SCOPE_PRIORITY[remoteScope];
  return localPri < remotePri ? localScope : remoteScope;
}

export interface ScopedRoute {
  prefix: string;
  scope: FederationScope;
  preference: number;
  measuredLatencyMs?: number;
}

export function selectBestRoute(routes: ScopedRoute[]): ScopedRoute | null {
  if (routes.length === 0) return null;

  const withLatency = routes.filter((r) => r.measuredLatencyMs !== undefined);
  if (withLatency.length > 0) {
    return withLatency.reduce((best, r) =>
      r.measuredLatencyMs! < best.measuredLatencyMs! ? r : best,
    );
  }

  return routes.reduce((best, r) => {
    const rPri = SCOPE_PRIORITY[r.scope] + r.preference;
    const bPri = SCOPE_PRIORITY[best.scope] + best.preference;
    return rPri > bPri ? r : best;
  });
}

export function haversineDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function isLocalCandidate(
  localCoords: [number, number],
  remoteCoords: [number, number],
  maxDistanceKm = 50,
): boolean {
  const dist = haversineDistanceKm(
    localCoords[0],
    localCoords[1],
    remoteCoords[0],
    remoteCoords[1],
  );
  return dist <= maxDistanceKm;
}

const M49_MACRO_REGIONS: Record<string, string> = {
  "002": "002", "014": "002", "017": "002", "015": "002", "018": "002", "011": "002", // Africa
  "019": "019", "419": "019", "029": "019", "013": "019", "005": "019", "021": "019", // Americas
  "142": "142", "143": "142", "030": "142", "034": "142", "035": "142", "145": "142", // Asia
  "150": "150", "151": "150", "154": "150", "039": "150", "155": "150",               // Europe
  "009": "009", "053": "009", "054": "009", "057": "009", "061": "009",               // Oceania
};

export function isSameRegion(localRegion: string, remoteRegion: string): boolean {
  if (localRegion === remoteRegion) return true;
  const localMacro = M49_MACRO_REGIONS[localRegion] ?? localRegion;
  const remoteMacro = M49_MACRO_REGIONS[remoteRegion] ?? remoteRegion;
  return localMacro === remoteMacro;
}
