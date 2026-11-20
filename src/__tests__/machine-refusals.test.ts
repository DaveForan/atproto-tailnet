/** Notifications for machines that a machine lock refused (ADR-0035). */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ results: [] as unknown[], writes: [] as unknown[], notifyUser: vi.fn() }));
vi.mock("../db/index.js", () => {
  const chain = (): unknown =>
    new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === "then") {
          const next = h.results.length ? h.results.shift() : [];
          return (res: (v: unknown) => unknown) => Promise.resolve(next).then(res);
        }
        return (...args: unknown[]) => {
          if (prop === "values") h.writes.push(args[0]);
          return chain();
        };
      },
    });
  return { db: { select: chain, insert: chain }, pool: {} };
});
vi.mock("../config.js", () => ({ config: { coordinatorUrl: "http://coord", coordinatorApiKey: "k" } }));
vi.mock("../logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("../notifications/service.js", () => ({ notifyUser: h.notifyUser }));

import { notifyRefusedMachines, MAX_REFUSALS_PER_ROUND } from "../orchestrator/machine-refusals.js";

const NOW = new Date("2026-11-20T12:00:00Z");
const refusal = (minute: number, tenant = "coord-1") => ({
  tenant_id: tenant,
  owner: "u-1",
  at: new Date(Date.UTC(2026, 10, 20, 11, minute)).toISOString(),
  hostname: `box-${minute}`,
  os: "linux",
  fingerprint: "abcd-ef01",
});

beforeEach(() => {
  h.results.length = 0;
  h.writes.length = 0;
  vi.clearAllMocks();
});

describe("notifyRefusedMachines", () => {
  it("the first run only sets the starting point", async () => {
    h.results.push([{ at: null }]);
    const list = vi.fn();
    expect(await notifyRefusedMachines(list, NOW)).toBe(0);
    expect(list).not.toHaveBeenCalled();
    expect(h.writes).toEqual([{ id: 1, machineRefusedSeenAt: NOW }]);
  });

  it("writes one notification for each new refusal and moves the starting point to the newest", async () => {
    const since = new Date("2026-11-20T11:00:00Z");
    h.results.push([{ at: since }], [{ id: "t-1", coordinatorTenantId: "coord-1" }]);
    const list = vi.fn(async () => [refusal(5), refusal(9), refusal(7, "unknown-tenant")]);
    expect(await notifyRefusedMachines(list, NOW)).toBe(2);
    expect(list).toHaveBeenCalledWith(since);
    expect(h.notifyUser).toHaveBeenCalledTimes(2);
    expect(h.notifyUser).toHaveBeenCalledWith("t-1", "u-1", "machine_refused", expect.objectContaining({
      title: 'Your device lock refused "box-5"',
      link: "/#devices",
    }));
    expect(h.writes.at(-1)).toEqual({ id: 1, machineRefusedSeenAt: new Date(refusal(9).at) });
  });

  it("nothing new writes nothing", async () => {
    h.results.push([{ at: NOW }]);
    expect(await notifyRefusedMachines(async () => [], NOW)).toBe(0);
    expect(h.writes).toEqual([]);
  });

  it("a flood is cut off for this round and continues from where it stopped", async () => {
    h.results.push([{ at: new Date("2026-11-20T10:00:00Z") }], [{ id: "t-1", coordinatorTenantId: "coord-1" }]);
    const many = Array.from({ length: MAX_REFUSALS_PER_ROUND + 9 }, (_, i) => ({ ...refusal(0), at: new Date(Date.UTC(2026, 10, 20, 11, 0, i)).toISOString() }));
    expect(await notifyRefusedMachines(async () => many, NOW)).toBe(MAX_REFUSALS_PER_ROUND);
    expect(h.writes.at(-1)).toEqual({ id: 1, machineRefusedSeenAt: new Date(many[MAX_REFUSALS_PER_ROUND - 1].at) });
  });
});
