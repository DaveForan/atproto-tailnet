/** Whether named HTTPS services are available: asked from the coordinator's health, kept for a minute. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock("../config.js", () => ({ config: { coordinatorUrl: "http://coord", coordinatorApiKey: "k" } }));
vi.mock("../orchestrator/coordinator-api.js", () => ({ CoordinatorApiClient: class { probeHealth = h.probe; } }));

import { httpsServiceDomain, httpsServicesAvailable, resetHttpsServicesCache } from "../orchestrator/gateway.js";

beforeEach(() => {
  vi.clearAllMocks();
  resetHttpsServicesCache();
});

describe("httpsServicesAvailable", () => {
  it("is what the coordinator says, and is asked once a minute", async () => {
    h.probe.mockResolvedValue({ bootId: "b", gateway: true, serviceDomain: "svc.ts.example.com" });
    expect(await httpsServicesAvailable(1_000)).toBe(true);
    expect(await httpsServicesAvailable(30_000)).toBe(true);
    expect(h.probe).toHaveBeenCalledTimes(1);
    h.probe.mockResolvedValue({ bootId: "b", gateway: false, serviceDomain: null });
    expect(await httpsServicesAvailable(62_000)).toBe(false);
    expect(h.probe).toHaveBeenCalledTimes(2);
  });

  it("an unreachable coordinator keeps the last answer and is asked again next time", async () => {
    h.probe.mockResolvedValueOnce(null);
    expect(await httpsServicesAvailable(1_000)).toBe(false);
    h.probe.mockResolvedValueOnce({ bootId: "b", gateway: true, serviceDomain: "svc.ts.example.com" });
    expect(await httpsServicesAvailable(2_000)).toBe(true);
    h.probe.mockResolvedValueOnce(null);
    expect(await httpsServicesAvailable(200_000)).toBe(true);
  });

  it("names services under the coordinator's service domain only", async () => {
    h.probe.mockResolvedValue({ bootId: "b", gateway: true, serviceDomain: "svc.ts.example.com" });
    expect(await httpsServiceDomain(1_000)).toBe("svc.ts.example.com");
    resetHttpsServicesCache();
    // A gateway without a service domain would need the control-plane certificate (ADR-0038)
    h.probe.mockResolvedValue({ bootId: "b", gateway: true, serviceDomain: null });
    expect(await httpsServicesAvailable(1_000)).toBe(false);
    expect(await httpsServiceDomain(1_000)).toBeNull();
  });
});
