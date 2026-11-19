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
import { canonicalize } from "./jcs.js";
import { signedPayload } from "./auth.js";

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

/**
 * Challenge nonces are 32 random bytes: base64url without padding (this
 * service) or 64 lowercase hex chars (the Rust coordinator). Both sides
 * enforce the format so a peer cannot pass arbitrary data off as a nonce.
 */
export const CHALLENGE_NONCE_RE = /^(?:[A-Za-z0-9_-]{43}|[0-9a-f]{64})$/;

export function isValidChallengeNonce(nonce: unknown): nonce is string {
  return typeof nonce === "string" && CHALLENGE_NONCE_RE.test(nonce);
}

/** Type tag of the challenge-response signing payload (never a CFP message type). */
export const CHALLENGE_RESPONSE_TYPE = "CFP_CHALLENGE_RESPONSE";

/**
 * What the initiator signs to answer a CHALLENGE: a typed, audience-bound
 * wrapper — never the peer-chosen nonce verbatim, which would make us a
 * signing oracle for any message (CFP or holder-binding) the peer picks.
 */
export function challengeResponsePayload(
  nonce: string,
  signerDid: string,
  audienceDid: string,
): string {
  return canonicalize({
    type: CHALLENGE_RESPONSE_TYPE,
    iss: signerDid,
    aud: audienceDid,
    nonce,
  });
}

/** Verify `message.signature` by `did` over {@link signedPayload}; false on any failure. */
async function verifySigned(
  callbacks: HandshakeCallbacks,
  did: string,
  message: { signature?: unknown },
): Promise<boolean> {
  if (typeof message.signature !== "string" || !message.signature) return false;
  let payload: string;
  try {
    payload = signedPayload(message);
  } catch {
    return false;
  }
  return callbacks.verifySignature(did, payload, message.signature);
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
  const unsigned: Omit<HelloMessage, "signature"> = {
    type: "HELLO",
    collectiveDid: state.localDid,
    federationType: type,
    offeredCidrs: cidrs,
    capabilities,
    protocolVersion: CFP_VERSION,
    timestamp: new Date().toISOString(),
  };
  const message: HelloMessage = { ...unsigned, signature: await callbacks.sign(signedPayload(unsigned)) };

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
  // Over the message as received: JCS of every member but `signature`.
  const valid = await verifySigned(callbacks, hello.collectiveDid, hello);

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

  const unsigned: Omit<ChallengeMessage, "signature"> = {
    type: "CHALLENGE",
    collectiveDid: state.localDid,
    nonce,
    expiresAt: expiresAt.toISOString(),
    acceptedType: hello.federationType,
    acceptedCidrs,
    acceptedCapabilities,
    negotiatedVersion,
    negotiatedKeepaliveSeconds: keepalive,
    timestamp: new Date().toISOString(),
  };
  const message: ChallengeMessage = { ...unsigned, signature: await callbacks.sign(signedPayload(unsigned)) };

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

  if (!state.remoteDid || challenge.collectiveDid !== state.remoteDid) {
    return {
      ok: false,
      state: { ...state, phase: "failed", error: "CHALLENGE from unexpected sender", updatedAt: new Date() },
      error: "CHALLENGE from unexpected sender",
    };
  }

  if (!isValidChallengeNonce(challenge.nonce)) {
    return {
      ok: false,
      state: { ...state, phase: "failed", error: "Malformed challenge nonce", updatedAt: new Date() },
      error: "Malformed challenge nonce",
    };
  }

  const challengeSignature = await callbacks.sign(
    challengeResponsePayload(challenge.nonce, state.localDid, state.remoteDid),
  );
  const routes = callbacks.getLocalRoutes();

  // Signed over JCS of every transmitted member except `signature` — the
  // same bytes the receiver rebuilds from the wire message.
  const unsigned: Omit<CommitMessage, "signature"> = {
    type: "COMMIT",
    collectiveDid: state.localDid,
    challengeNonce: challenge.nonce,
    challengeSignature,
    initialRoutes: routes,
    timestamp: new Date().toISOString(),
  };
  const message: CommitMessage = { ...unsigned, signature: await callbacks.sign(signedPayload(unsigned)) };

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

  if (!state.remoteDid || commit.collectiveDid !== state.remoteDid) {
    return {
      ok: false,
      state: { ...state, phase: "failed", error: "COMMIT from unexpected sender", updatedAt: new Date() },
      error: "COMMIT from unexpected sender",
    };
  }

  if (!isValidChallengeNonce(commit.challengeNonce) || commit.challengeNonce !== state.challengeNonce) {
    return {
      ok: false,
      state: { ...state, phase: "failed", error: "Nonce mismatch", updatedAt: new Date() },
      error: "Challenge nonce mismatch",
    };
  }

  // The COMMIT itself (its routes, timestamp) must be signed by the peer,
  // over the message as received.
  const commitValid = await verifySigned(callbacks, commit.collectiveDid, commit);
  if (!commitValid) {
    return {
      ok: false,
      state: { ...state, phase: "failed", error: "Invalid COMMIT signature", updatedAt: new Date() },
      error: "Invalid COMMIT signature",
    };
  }

  const nonceValid = await callbacks.verifySignature(
    commit.collectiveDid,
    challengeResponsePayload(commit.challengeNonce, commit.collectiveDid, state.localDid),
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

  const unsigned: Omit<EstablishedMessage, "signature"> = {
    type: "ESTABLISHED",
    sessionId,
    collectiveDid: state.localDid,
    initialRoutes: routes,
    keepaliveIntervalSeconds: state.keepaliveSeconds ?? DEFAULT_KEEPALIVE_SECONDS,
    timestamp: new Date().toISOString(),
  };
  const message: EstablishedMessage = { ...unsigned, signature: await callbacks.sign(signedPayload(unsigned)) };

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
