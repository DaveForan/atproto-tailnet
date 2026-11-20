/**
 * @module orchestrator/leader
 * The one leader lock of this service. Background work that must run once per
 * instance checks `isLeader()` at the start of each tick (ADR-0034).
 */
import { pool } from "../db/index.js";
import { LeaderLock } from "../db/locks.js";

const leader = new LeaderLock(pool);

export const startLeaderElection = (): Promise<void> => leader.start();
export const stopLeaderElection = (): Promise<void> => leader.stop();
export const isLeader = (): boolean => leader.isLeader();
