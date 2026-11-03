import { describe, it, expect } from "vitest";
import {
  negotiateScope,
  conservativeScope,
  selectBestRoute,
  haversineDistanceKm,
  isLocalCandidate,
  isSameRegion,
  scopeDeclarationSchema,
  SCOPE_PRIORITY,
} from "../federation/scoping.js";
import type { ScopedRoute, FederationScope } from "../federation/scoping.js";

describe("negotiateScope", () => {
  it("picks local when both support it", () => {
    expect(negotiateScope(["local", "regional"], ["local", "global"])).toBe("local");
  });

  it("picks regional when both support it but not local", () => {
    expect(negotiateScope(["regional", "global"], ["regional"])).toBe("regional");
  });

  it("picks global as fallback", () => {
    expect(negotiateScope(["global"], ["global"])).toBe("global");
  });

  it("returns null when no overlap", () => {
    expect(negotiateScope(["local"], ["global"])).toBeNull();
  });
});

describe("conservativeScope", () => {
  it("picks the stricter scope (lower priority = stricter)", () => {
    expect(conservativeScope("local", "global")).toBe("global");
    expect(conservativeScope("global", "local")).toBe("global");
  });

  it("returns same scope when equal", () => {
    expect(conservativeScope("regional", "regional")).toBe("regional");
  });
});

describe("selectBestRoute", () => {
  it("prefers measured latency when available", () => {
    const routes: ScopedRoute[] = [
      { prefix: "10.0.0.0/8", scope: "global", preference: 100, measuredLatencyMs: 50 },
      { prefix: "10.0.0.0/8", scope: "local", preference: 100, measuredLatencyMs: 200 },
    ];
    const best = selectBestRoute(routes);
    expect(best?.scope).toBe("global"); // lower latency wins
  });

  it("uses scope priority when no latency data", () => {
    const routes: ScopedRoute[] = [
      { prefix: "10.0.0.0/8", scope: "global", preference: 100 },
      { prefix: "10.0.0.0/8", scope: "local", preference: 100 },
    ];
    const best = selectBestRoute(routes);
    expect(best?.scope).toBe("local"); // higher scope priority
  });

  it("adds preference to scope priority", () => {
    const routes: ScopedRoute[] = [
      { prefix: "10.0.0.0/8", scope: "global", preference: 250 },
      { prefix: "10.0.0.0/8", scope: "local", preference: 0 },
    ];
    const best = selectBestRoute(routes);
    // global: 100 + 250 = 350, local: 300 + 0 = 300
    expect(best?.scope).toBe("global");
  });

  it("returns null for empty routes", () => {
    expect(selectBestRoute([])).toBeNull();
  });
});

describe("haversineDistanceKm", () => {
  it("calculates distance between Boston and NYC (~306 km)", () => {
    const dist = haversineDistanceKm(42.36, -71.06, 40.71, -74.01);
    expect(dist).toBeGreaterThan(280);
    expect(dist).toBeLessThan(330);
  });

  it("returns 0 for same coordinates", () => {
    expect(haversineDistanceKm(0, 0, 0, 0)).toBe(0);
  });
});

describe("isLocalCandidate", () => {
  it("accepts collectives within 50km", () => {
    // Two points ~10km apart in Boston
    expect(isLocalCandidate([42.36, -71.06], [42.35, -71.05])).toBe(true);
  });

  it("rejects collectives beyond 50km", () => {
    // Boston to NYC
    expect(isLocalCandidate([42.36, -71.06], [40.71, -74.01])).toBe(false);
  });

  it("respects custom distance threshold", () => {
    expect(isLocalCandidate([42.36, -71.06], [40.71, -74.01], 500)).toBe(true);
  });
});

describe("isSameRegion", () => {
  it("matches identical codes", () => {
    expect(isSameRegion("021", "021")).toBe(true);
  });

  it("matches sub-regions within the same macro-region (Americas)", () => {
    expect(isSameRegion("021", "029")).toBe(true);
  });

  it("rejects different macro-regions", () => {
    expect(isSameRegion("021", "150")).toBe(false);
  });
});

describe("scopeDeclarationSchema", () => {
  it("accepts valid declaration", () => {
    const result = scopeDeclarationSchema.safeParse({
      scopes: ["local", "regional"],
      region: "021",
      coordinates: [42.36, -71.06],
      scopePolicies: {
        local: { autoAccept: true, verification: "standard" },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid region code", () => {
    const result = scopeDeclarationSchema.safeParse({
      scopes: ["regional"],
      region: "XX",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid coordinates", () => {
    const result = scopeDeclarationSchema.safeParse({
      scopes: ["local"],
      coordinates: [200, -71],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty scopes", () => {
    const result = scopeDeclarationSchema.safeParse({
      scopes: [],
    });
    expect(result.success).toBe(false);
  });

  it("accepts minimal declaration", () => {
    const result = scopeDeclarationSchema.safeParse({
      scopes: ["global"],
    });
    expect(result.success).toBe(true);
  });
});
