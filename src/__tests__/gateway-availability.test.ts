/** Whether named HTTPS services are available: asked from the coordinator's health, kept for a minute. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ probe: vi.fn(), url: "http://coord" as string | undefined }));
vi.mock("../config.js", () => ({ config: { get coordinatorUrl() { return h.url; }, coordinatorApiKey: "k" } }));
vi.mock("../orchestrator/coordinator-api.js", () => ({ CoordinatorApiClient: class { probeHealth = h.probe; } }));

import { httpsServicesAvailable, resetHttpsServicesCache } from "../orchestrator/gateway.js";

beforeEach(() => {
  vi.clearAllMocks();
  resetHttpsServicesCache();
  h.url = "http://coord";
});

describe("httpsServicesAvailable", () => {
  it("is what the coordinator says, and is asked once a minute", async () => {
    h.probe.mockResolvedValue({ bootId: "b", gateway: true });
    expect(await httpsServicesAvailable(1_000)).toBe(true);
    expect(await httpsServicesAvailable(30_000)).toBe(true);
    expect(h.probe).toHaveBeenCalledTimes(1);
    h.probe.mockResolvedValue({ bootId: "b", gateway: false });
    expect(await httpsServicesAvailable(62_000)).toBe(false);
    expect(h.probe).toHaveBeenCalledTimes(2);
  });

  it("an unreachable coordinator keeps the last answer and is asked again next time", async () => {
    h.probe.mockResolvedValueOnce(null);
    expect(await httpsServicesAvailable(1_000)).toBe(false);
    h.probe.mockResolvedValueOnce({ bootId: "b", gateway: true });
    expect(await httpsServicesAvailable(2_000)).toBe(true);
    h.probe.mockResolvedValueOnce(null);
    expect(await httpsServicesAvailable(200_000)).toBe(true);
  });

  it("is false outside coordinator mode, without a call", async () => {
    h.url = undefined;
    expect(await httpsServicesAvailable()).toBe(false);
    expect(h.probe).not.toHaveBeenCalled();
  });
});
