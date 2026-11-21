/**
 * @module db/locks
 * Cross-replica locks on PostgreSQL session advisory locks (ADR-0034, stage A).
 * A lock belongs to one connection: PostgreSQL releases it when the holder stops.
 */

import { logger } from "../logger.js";

/** Lock keys of this application (any fixed, distinct 32-bit numbers). */
export const LOCK_TAILNET_CREATION = 0x41544e01;
export const LOCK_LEADER = 0x41544e02;

export interface LockClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(destroy?: boolean | Error): void;
  on?(event: "error", listener: (err: Error) => void): unknown;
}
export interface LockPool {
  connect(): Promise<LockClient>;
}

/**
 * Run `fn` while holding an advisory lock; other replicas wait. `fn` uses its
 * own connections, so the lock is a session lock on a dedicated connection.
 */
export async function withAdvisoryLock<T>(pool: LockPool, key: number, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [key]);
    try {
      return await fn();
    } finally {
      // If the unlock fails, closing the connection releases the lock
      await client.query("SELECT pg_advisory_unlock($1)", [key]).catch(() => {
        broken = true;
      });
    }
  } catch (err) {
    broken = true;
    throw err;
  } finally {
    client.release(broken);
  }
}

/**
 * Leader election: at most one replica holds the lock and runs once-per-instance work (monitor, broker, sweeps).
 * When the leader loses its connection, another replica takes over at its next attempt.
 */
export class LeaderLock {
  private client: LockClient | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private attempting = false;

  constructor(
    private readonly pool: LockPool,
    private readonly key: number = LOCK_LEADER,
    private readonly retryMs = 10_000,
  ) {}

  isLeader(): boolean {
    return this.client !== null;
  }

  /** Try now, then keep trying (and checking the connection) in the background. */
  async start(): Promise<void> {
    if (this.timer) return;
    this.timer = setInterval(() => void this.attempt(), this.retryMs);
    this.timer.unref?.();
    await this.attempt();
  }

  async attempt(): Promise<void> {
    if (this.attempting) return;
    this.attempting = true;
    try {
      if (this.client) {
        // Still the leader only while the connection that holds the lock lives
        await this.client.query("SELECT 1");
        return;
      }
      const client = await this.pool.connect();
      try {
        const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [this.key]);
        if (rows[0]?.ok === true) {
          client.on?.("error", () => this.lose(client));
          this.client = client;
          logger.info("this replica is now the leader for background work");
        } else {
          client.release();
        }
      } catch (err) {
        client.release(true);
        throw err;
      }
    } catch (err) {
      if (this.client) this.lose(this.client);
      else logger.warn({ err }, "leader election attempt failed");
    } finally {
      this.attempting = false;
    }
  }

  private lose(client: LockClient): void {
    if (this.client !== client) return;
    this.client = null;
    client.release(true);
    logger.warn("this replica lost the leader lock");
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const client = this.client;
    this.client = null;
    if (client) {
      await client.query("SELECT pg_advisory_unlock($1)", [this.key]).catch(() => undefined);
      client.release();
    }
  }
}
