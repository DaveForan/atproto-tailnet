/**
 * @module federation/session
 * Federation session lifecycle — keepalive and revocation (ADR-0014 sections 5-6).
 */

import type {
  KeepaliveMessage,
  RevokeMessage,
  FederationType,
  Capability,
} from "./protocol.js";
import { DRAIN_PERIOD_SECONDS, DEFAULT_KEEPALIVE_SECONDS } from "./protocol.js";

export type SessionStatus = "connecting" | "established" | "degraded" | "down" | "draining" | "revoked";

export interface FederationSession {
  sessionId: string;
  localDid: string;
  remoteDid: string;
  status: SessionStatus;
  federationType: FederationType;
  negotiatedCidrs: string[];
  capabilities: Capability[];
  keepaliveIntervalSeconds: number;
  lastKeepaliveSent: Date;
  lastKeepaliveReceived: Date;
  missedKeepalives: number;
  sequenceNumber: number;
  createdAt: Date;
  updatedAt: Date;
}

export function createSession(
  sessionId: string,
  localDid: string,
  remoteDid: string,
  type: FederationType,
  cidrs: string[],
  capabilities: Capability[],
  keepaliveSeconds: number,
): FederationSession {
  const now = new Date();
  return {
    sessionId,
    localDid,
    remoteDid,
    status: "established",
    federationType: type,
    negotiatedCidrs: cidrs,
    capabilities,
    keepaliveIntervalSeconds: keepaliveSeconds,
    lastKeepaliveSent: now,
    lastKeepaliveReceived: now,
    missedKeepalives: 0,
    sequenceNumber: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function generateKeepalive(session: FederationSession): KeepaliveMessage {
  session.sequenceNumber++;
  session.lastKeepaliveSent = new Date();
  session.updatedAt = new Date();
  return {
    type: "KEEPALIVE",
    sessionId: session.sessionId,
    sequenceNumber: session.sequenceNumber,
    timestamp: new Date().toISOString(),
  };
}

export function handleKeepaliveReceived(session: FederationSession): void {
  session.lastKeepaliveReceived = new Date();
  session.missedKeepalives = 0;
  if (session.status === "degraded") {
    session.status = "established";
  }
  session.updatedAt = new Date();
}

export function checkKeepaliveHealth(session: FederationSession): SessionStatus {
  const now = Date.now();
  const interval = (session.keepaliveIntervalSeconds || DEFAULT_KEEPALIVE_SECONDS) * 1000;
  const elapsed = now - session.lastKeepaliveReceived.getTime();
  const missedCount = Math.floor(elapsed / interval);

  session.missedKeepalives = missedCount;
  session.updatedAt = new Date();

  if (missedCount >= 5) {
    session.status = "down";
    return "down";
  }
  if (missedCount >= 3) {
    session.status = "degraded";
    return "degraded";
  }
  return session.status;
}

export function initiateRevoke(
  session: FederationSession,
  reason: string | undefined,
  permanent: boolean,
): { message: RevokeMessage; drainDeadline: Date } {
  session.status = "draining";
  session.updatedAt = new Date();

  const message: RevokeMessage = {
    type: "REVOKE",
    sessionId: session.sessionId,
    reason,
    permanent,
    signature: "",
    timestamp: new Date().toISOString(),
  };

  return {
    message,
    drainDeadline: new Date(Date.now() + DRAIN_PERIOD_SECONDS * 1000),
  };
}

export function finalizeRevoke(session: FederationSession): void {
  session.status = "revoked";
  session.updatedAt = new Date();
}

export function handleRemoteRevoke(
  session: FederationSession,
  _revoke: RevokeMessage,
): void {
  session.status = "revoked";
  session.updatedAt = new Date();
}
