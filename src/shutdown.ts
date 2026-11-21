/**
 * Graceful stop on SIGTERM/SIGINT. Order: refuse new connections, stop loops, close the pool, exit.
 * A timer forces the exit.
 */

import type { Server } from "node:http";
import { logger } from "./logger.js";

export interface ShutdownDeps {
  server: Pick<Server, "close">;
  stopLoops: Array<() => void | Promise<void>>;
  closePool: () => Promise<void>;
  exit: (code: number) => void;
  /** Forced exit after this many milliseconds. */
  timeoutMs?: number;
}

/** Returns the signal handler. A second signal while stopping does nothing. */
export function createShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
  let stopping = false;
  return async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutting down");
    const force = setTimeout(() => {
      logger.error("shutdown timed out, forcing exit");
      deps.exit(1);
    }, deps.timeoutMs ?? 10_000);
    force.unref?.();
    let code = 0;
    try {
      const closed = new Promise<void>((resolve) => deps.server.close(() => resolve()));
      for (const stop of deps.stopLoops) {
        try {
          await stop();
        } catch (err) {
          code = 1;
          logger.warn({ err }, "failed to stop a background loop");
        }
      }
      // Open requests finish before the pool closes
      await closed;
      await deps.closePool();
    } catch (err) {
      code = 1;
      logger.error({ err }, "shutdown failed");
    }
    clearTimeout(force);
    deps.exit(code);
  };
}
