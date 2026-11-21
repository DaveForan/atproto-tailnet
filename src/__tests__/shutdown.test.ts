/** Graceful shutdown order and the forced exit. */
import { describe, it, expect, vi } from "vitest";
import { createShutdown } from "../shutdown.js";

describe("createShutdown", () => {
  it("closes the server, stops loops, closes the pool, then exits 0", async () => {
    const log: string[] = [];
    const exit = vi.fn((c: number) => log.push(`exit:${c}`));
    const shutdown = createShutdown({
      server: { close: (cb?: (err?: Error) => void) => (log.push("close"), setImmediate(() => cb?.()), undefined) } as never,
      stopLoops: [() => void log.push("broker"), async () => void log.push("leader")],
      closePool: async () => void log.push("pool"),
      exit,
    });
    await shutdown("SIGTERM");
    await shutdown("SIGTERM");
    expect(log).toEqual(["close", "broker", "leader", "pool", "exit:0"]);
  });

  it("forces exit 1 when the server does not close in time", async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const shutdown = createShutdown({
      server: { close: () => undefined } as never,
      stopLoops: [],
      closePool: async () => {},
      exit,
      timeoutMs: 50,
    });
    void shutdown("SIGINT");
    await vi.advanceTimersByTimeAsync(60);
    expect(exit).toHaveBeenCalledWith(1);
    vi.useRealTimers();
  });

  it("exits 1 when a loop fails to stop, after closing the pool", async () => {
    const closePool = vi.fn(async () => {});
    const exit = vi.fn();
    await createShutdown({
      server: { close: (cb?: () => void) => (cb?.(), undefined) } as never,
      stopLoops: [() => Promise.reject(new Error("x"))],
      closePool,
      exit,
    })("SIGTERM");
    expect(closePool).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
