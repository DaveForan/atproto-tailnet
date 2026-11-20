/** Cluster-wide locks on PostgreSQL advisory locks (ADR-0034), against a fake server. */
import { describe, it, expect, vi } from "vitest";
vi.mock("../logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { withAdvisoryLock, LeaderLock, type LockClient } from "../db/locks.js";

/** A fake PostgreSQL: session advisory locks owned by connections, shared by all "replicas". */
function fakeServer() {
  const held = new Map<number, object>();
  const waiters = new Map<number, Array<() => void>>();
  let down = false;
  const free = (key: number) => {
    held.delete(key);
    waiters.get(key)?.shift()?.();
  };
  const pool = {
    connects: 0,
    async connect(): Promise<LockClient> {
      if (down) throw new Error("connection refused");
      pool.connects++;
      const me = {};
      return {
        async query(text: string, values: unknown[] = []) {
          if (down) throw new Error("connection lost");
          const key = values[0] as number;
          if (text.includes("pg_try_advisory_lock")) {
            if (held.has(key)) return { rows: [{ ok: false }] };
            held.set(key, me);
            return { rows: [{ ok: true }] };
          }
          if (text.includes("pg_advisory_lock")) {
            while (held.has(key)) await new Promise<void>((r) => waiters.set(key, [...(waiters.get(key) ?? []), r]));
            held.set(key, me);
          } else if (text.includes("pg_advisory_unlock")) {
            if (held.get(key) === me) free(key);
          }
          return { rows: [] };
        },
        release(destroy?: boolean | Error) {
          // A closed connection gives up its locks
          if (destroy) for (const [k, owner] of held) if (owner === me) free(k);
        },
      };
    },
  };
  return { pool, held, setDown: (v: boolean) => (down = v), dropLocks: () => [...held.keys()].forEach(free) };
}

describe("withAdvisoryLock", () => {
  it("lets one holder in at a time across two replicas, also when one throws", async () => {
    const { pool, held } = fakeServer();
    let active = 0;
    let max = 0;
    const section = (fail = false) =>
      withAdvisoryLock(pool, 7, async () => {
        active++;
        max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        if (fail) throw new Error("boom");
        return "done";
      });
    const out = await Promise.allSettled([section(true), section(), section()]);
    expect(max).toBe(1);
    expect(out.map((r) => r.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
    expect(held.size).toBe(0);
  });
});

describe("LeaderLock", () => {
  it("exactly one of two replicas is the leader; the other takes over when it stops", async () => {
    const { pool } = fakeServer();
    const a = new LeaderLock(pool, 9, 1_000_000);
    const b = new LeaderLock(pool, 9, 1_000_000);
    await a.start();
    await b.start();
    expect([a.isLeader(), b.isLeader()]).toEqual([true, false]);
    await b.attempt();
    expect(b.isLeader()).toBe(false);

    await a.stop();
    expect(a.isLeader()).toBe(false);
    await b.attempt();
    expect(b.isLeader()).toBe(true);
    await b.stop();
  });

  it("a leader that loses its connection stops being the leader and can win again", async () => {
    const server = fakeServer();
    const a = new LeaderLock(server.pool, 9, 1_000_000);
    await a.start();
    expect(a.isLeader()).toBe(true);

    server.setDown(true);
    await a.attempt();
    expect(a.isLeader()).toBe(false);
    await a.attempt(); // still down: no crash, not the leader
    expect(a.isLeader()).toBe(false);

    server.setDown(false);
    await a.attempt();
    expect(a.isLeader()).toBe(true);
    await a.stop();
  });

  it("a replica that does not win gives its connection back", async () => {
    const { pool } = fakeServer();
    const a = new LeaderLock(pool, 9, 1_000_000);
    const b = new LeaderLock(pool, 9, 1_000_000);
    await a.start();
    const release = vi.fn();
    const connect = pool.connect.bind(pool);
    pool.connect = async () => {
      const c = await connect();
      const orig = c.release.bind(c);
      c.release = (d?: boolean | Error) => {
        release(d);
        orig(d);
      };
      return c;
    };
    await b.attempt();
    expect(release).toHaveBeenCalledTimes(1);
    await a.stop();
    await b.stop();
  });
});
