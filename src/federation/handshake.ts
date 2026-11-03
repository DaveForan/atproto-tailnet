/**
 * @module federation/handshake
 * CFP 4-phase handshake state machine (ADR-0014).
 */

import { randomBytes } from "node:crypto";
import type {
  HandshakePhase,
  HelloMessage,
  ChallengeMessage,
  CommitMessage,
  EstablishedMessage,
  FederationType,
  Capability,
  RouteAnnouncement,
} from "./protocol.js";
import {
  CFP_VERSION,
  DEFAULT_KEEPALIVE_SECONDS,
  KEEPALIVE_RANGE,
  CHALLENGE_EXPIRY_DEFAULT_SECONDS,
} from "./protocol.js";

function negotiateVersion(remote: string, local: string): string {
  const rParts = remote.split(".").map(Number);
  const lParts = local.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((rParts[i] ?? 0) < (lParts[i] ?? 0)) return remote;
    if ((rParts[i] ?? 0) > (lParts[i] ?? 0)) return local;
  }
  return local;
}

export interface HandshakeState {
  phase: HandshakePhase;
  localDid: string;
  remoteDid?: string;
  sessionId?: string;
  negotiatedVersion?: string;
  negotiatedType?: FederationType;
  negotiatedCidrs?: string[];
  negotiatedCapabilities?: Capability[];
  keepaliveSeconds?: number;
  challengeNonce?: string;
  challengeExpiresAt?: Date;
  error?: string;
  startedAt: Date;
  updatedAt: Date;
}

export interface HandshakeCallbacks {
  sign(payload: string): Promise<string>;
  verifySignature(did: string, payload: string, signature: string): Promise<boolean>;
  evaluatePolicy(remoteDid: string, type: FederationType): Promise<boolean>;
  getLocalRoutes(): RouteAnnouncement[];
}

export function createHandshake(localDid: string): HandshakeState {
  return {
    phase: "idle",
    localDid,
    startedAt: new Date(),
    updatedAt: new Date(),
  };
}

export async function initiateHello(
  state: HandshakeState,
  remoteDid: string,
  type: FederationType,
  cidrs: string[],
  capabilities: Capability[],
  callbacks: HandshakeCallbacks,
): Promise<{ state: HandshakeState; message: HelloMessage }> {
  const timestamp = new Date().toISOString();
  const payload = JSON.stringify({
    type: "HELLO",
    collectiveDid: state.localDid,
    federationType: type,
    offeredCidrs: cidrs,
    capabilities,
    protocolVersion: CFP_VERSION,
    timestamp,
  });

  const signature = await callbacks.sign(payload);

  const message: HelloMessage = {
    type: "HELLO",
    collectiveDid: state.localDid,
    federationType: type,
    offeredCidrs: cidrs,
    capabilities,
    protocolVersion: CFP_VERSION,
    signature,
    timestamp,
  };

  return {
    state: {
      ...state,
      phase: "hello_sent",
      remoteDid,
      negotiatedType: type,
      updatedAt: new Date(),
    },
    message,
  };
}

export async function handleHello(
  state: HandshakeState,
  hello: HelloMessage,
  localCidrs: string[],
  localCapabilities: Capability[],
  callbacks: HandshakeCallbacks,
): Promise<
  | { ok: true; state: HandshakeState; message: ChallengeMessage }
  | { ok: false; state: HandshakeState; error: string }
> {
  const valid = await callbacks.verifySignature(
    hello.collectiveDid,
    JSON.stringify({ ...hello, signature: undefined }),
    hello.signature,
  );

  if (!valid) {
    return {
      ok: false,
      state: { ...state, phase: "failed", error: "Invalid HELLO signature", updatedAt: new Date() },
      error: "Invalid HELLO signature",
    };
  }

  const policyOk = await callbacks.evaluatePolicy(hello.collectiveDid, hello.federationType);
  if (!policyOk) {
    return {
      ok: false,
      state: { ...state, phase: "failed", error: "Policy denied federation", updatedAt: new Date() },
      error: "Policy denied federation",
    };
  }

  const negotiatedVersion = negotiateVersion(hello.protocolVersion, CFP_VERSION);
  const offeredSet = new Set(hello.offeredCidrs);
  const acceptedCidrs = localCidrs.length === 0 && hello.offeredCidrs.length === 0
    ? []
    : localCidrs.filter((c) => offeredSet.has(c) || hello.offeredCidrs.length === 0);
  const acceptedCapabilities = localCapabilities.filter((c) => hello.capabilities.includes(c));
  const nonce = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + CHALLENGE_EXPIRY_DEFAULT_SECONDS * 1000);
  const keepalive = Math.max(KEEPALIVE_RANGE.min, Math.min(KEEPALIVE_RANGE.max, DEFAULT_KEEPALIVE_SECONDS));

  const timestamp = new Date().toISOString();
  const payload = JSON.stringify({
    type: "CHALLENGE",
    collectiveDid: state.localDid,
    nonce,
    expiresAt: expiresAt.toISOString(),
    acceptedType: hello.federationType,
    acceptedCidrs,
    acceptedCapabilities,
    negotiatedVersion,
    negotiatedKeepaliveSeconds: keepalive,
    timestamp,
  });

  const signature = await callbacks.sign(payload);

  const message: ChallengeMessage = {
    type: "CHALLENGE",
    collectiveDid: state.localDid,
    nonce,
    expiresAt: expiresAt.toISOString(),
    acceptedType: hello.federationType,
    acceptedCidrs,
    acceptedCapabilities,
    negotiatedVersion,
    negotiatedKeepaliveSeconds: keepalive,
    signature,
    timestamp,
  };

  return {
    ok: true,
    state: {
      ...state,
      phase: "challenge_sent",
      remoteDid: hello.collectiveDid,
      challengeNonce: nonce,
      challengeExpiresAt: expiresAt,
      negotiatedType: hello.federationType,
      negotiatedVersion,
      negotiatedCidrs: acceptedCidrs,
      negotiatedCapabilities: acceptedCapabilities,
      keepaliveSeconds: keepalive,
      updatedAt: new Date(),
    },
    message,
  };
}

export async function handleChallenge(
  state: HandshakeState,
  challenge: ChallengeMessage,
  callbacks: HandshakeCallbacks,
): Promise<
  | { ok: true; state: HandshakeState; message: CommitMessage }
  | { ok: false; state: HandshakeState; error: string }
> {
  if (state.phase !== "hello_sent") {
    return {
      ok: false,
      state: { ...state, phase: "failed", error: "Unexpected CHALLENGE", updatedAt: new Date() },
      error: "Unexpected CHALLENGE in phase " + state.phase,
    };
  }

  if (new Date(challenge.expiresAt) < new Date()) {
    return {
      ok: false,
      state: { ...state, phase: "failed", error: "Challenge expired", updatedAt: new Date() },
      error: "Challenge expired",
    };
  }

  const challengeSignature = await callbacks.sign(challenge.nonce);
  const routes = callbacks.getLocalRoutes();

  const timestamp = new Date().toISOString();
  const payload = JSON.stringify({
    type: "COMMIT",
    collectiveDid: state.localDid,
    challengeNonce: challenge.nonce,
    initialRoutes: routes,
    timestamp,
  });

  const signature = await callbacks.sign(payload);

  const message: CommitMessage = {
    type: "COMMIT",
    collectiveDid: state.localDid,
    challengeNonce: challenge.nonce,
    challengeSignature,
    initialRoutes: routes,
    signature,
    timestamp,
  };

  return {
    ok: true,
    state: {
      ...state,
      phase: "commit_sent",
      negotiatedVersion: challenge.negotiatedVersion,
      negotiatedType: challenge.acceptedType,
      negotiatedCidrs: challenge.acceptedCidrs,
      negotiatedCapabilities: challenge.acceptedCapabilities,
      keepaliveSeconds: challenge.negotiatedKeepaliveSeconds,
      updatedAt: new Date(),
    },
    message,
  };
}

export async function handleCommit(
  state: HandshakeState,
  commit: CommitMessage,
  callbacks: HandshakeCallbacks,
): Promise<
  | { ok: true; state: HandshakeState; message: EstablishedMessage }
  | { ok: false; state: HandshakeState; error: string }
> {
  if (state.phase !== "challenge_sent") {
    return {
      ok: false,
      state: { ...state, phase: "failed", error: "Unexpected COMMIT", updatedAt: new Date() },
      error: "Unexpected COMMIT in phase " + state.phase,
    };
  }

  if (state.challengeExpiresAt && state.challengeExpiresAt < new Date()) {
    return {
      ok: false,
      state: { ...state, phase: "failed", error: "Challenge expired", updatedAt: new Date() },
      error: "Challenge expired before COMMIT received",
    };
  }

  if (commit.challengeNonce !== state.challengeNonce) {
    return {
      ok: false,
      state: { ...state, phase: "failed", error: "Nonce mismatch", updatedAt: new Date() },
      error: "Challenge nonce mismatch",
    };
  }

  const nonceValid = await callbacks.verifySignature(
    commit.collectiveDid,
    commit.challengeNonce,
    commit.challengeSignature,
  );

  if (!nonceValid) {
    return {
      ok: false,
      state: { ...state, phase: "failed", error: "Invalid nonce signature", updatedAt: new Date() },
      error: "Invalid challenge nonce signature",
    };
  }

  const sessionId = randomBytes(16).toString("hex");
  const routes = callbacks.getLocalRoutes();

  const timestamp = new Date().toISOString();
  const payload = JSON.stringify({
    type: "ESTABLISHED",
    sessionId,
    collectiveDid: state.localDid,
    initialRoutes: routes,
    keepaliveIntervalSeconds: state.keepaliveSeconds ?? DEFAULT_KEEPALIVE_SECONDS,
    timestamp,
  });

  const signature = await callbacks.sign(payload);

  const message: EstablishedMessage = {
    type: "ESTABLISHED",
    sessionId,
    collectiveDid: state.localDid,
    initialRoutes: routes,
    keepaliveIntervalSeconds: state.keepaliveSeconds ?? DEFAULT_KEEPALIVE_SECONDS,
    signature,
    timestamp,
  };

  return {
    ok: true,
    state: {
      ...state,
      phase: "established",
      sessionId,
      updatedAt: new Date(),
    },
    message,
  };
}

export function handleEstablished(
  state: HandshakeState,
  established: EstablishedMessage,
): HandshakeState {
  if (state.phase !== "commit_sent") {
    return { ...state, phase: "failed", error: "Unexpected ESTABLISHED", updatedAt: new Date() };
  }

  return {
    ...state,
    phase: "established",
    sessionId: established.sessionId,
    keepaliveSeconds: established.keepaliveIntervalSeconds,
    updatedAt: new Date(),
  };
}
