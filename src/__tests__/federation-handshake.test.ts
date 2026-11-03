import { describe, it, expect } from "vitest";
import {
  createHandshake,
  initiateHello,
  handleHello,
  handleChallenge,
  handleCommit,
  handleEstablished,
} from "../federation/handshake.js";
import type { HandshakeCallbacks } from "../federation/handshake.js";
import type { FederationType } from "../federation/protocol.js";

const INITIATOR_DID = "did:web:alpha.example.com";
const RESPONDER_DID = "did:web:beta.example.com";

function stubCallbacks(opts: { policyAllow?: boolean } = {}): HandshakeCallbacks {
  return {
    sign: async (payload: string) => "sig:" + payload.slice(0, 20),
    verifySignature: async () => true,
    evaluatePolicy: async () => opts.policyAllow ?? true,
    getLocalRoutes: () => [
      {
        prefix: "10.0.0.0/24",
        originDid: RESPONDER_DID,
        pathVector: [RESPONDER_DID],
        preference: 100,
        originSignature: "sig",
      },
    ],
  };
}

describe("CFP handshake", () => {
  it("completes a full 4-phase handshake", async () => {
    const initiator = createHandshake(INITIATOR_DID);
    const responder = createHandshake(RESPONDER_DID);
    const iCb = stubCallbacks();
    const rCb = stubCallbacks();

    expect(initiator.phase).toBe("idle");
    expect(responder.phase).toBe("idle");

    // Phase 1: HELLO
    const hello = await initiateHello(
      initiator,
      RESPONDER_DID,
      "peer",
      ["10.1.0.0/16"],
      ["route-exchange"],
      iCb,
    );
    expect(hello.state.phase).toBe("hello_sent");
    expect(hello.message.type).toBe("HELLO");
    expect(hello.message.collectiveDid).toBe(INITIATOR_DID);

    // Phase 2: CHALLENGE
    const challenge = await handleHello(
      responder,
      hello.message,
      ["10.2.0.0/16"],
      ["route-exchange", "dns-forward"],
      rCb,
    );
    expect(challenge.ok).toBe(true);
    if (!challenge.ok) return;
    expect(challenge.state.phase).toBe("challenge_sent");
    expect(challenge.message.type).toBe("CHALLENGE");
    expect(challenge.message.acceptedCapabilities).toEqual(["route-exchange"]);

    // Phase 3: COMMIT
    const commit = await handleChallenge(hello.state, challenge.message, iCb);
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;
    expect(commit.state.phase).toBe("commit_sent");
    expect(commit.message.type).toBe("COMMIT");
    expect(commit.message.challengeNonce).toBe(challenge.message.nonce);

    // Phase 4: ESTABLISHED
    const established = await handleCommit(challenge.state, commit.message, rCb);
    expect(established.ok).toBe(true);
    if (!established.ok) return;
    expect(established.state.phase).toBe("established");
    expect(established.message.type).toBe("ESTABLISHED");
    expect(established.message.sessionId).toBeTruthy();

    // Initiator finalizes
    const finalState = handleEstablished(commit.state, established.message);
    expect(finalState.phase).toBe("established");
    expect(finalState.sessionId).toBe(established.message.sessionId);
  });

  it("denies handshake when policy rejects", async () => {
    const initiator = createHandshake(INITIATOR_DID);
    const responder = createHandshake(RESPONDER_DID);
    const iCb = stubCallbacks();
    const rCb = stubCallbacks({ policyAllow: false });

    const hello = await initiateHello(initiator, RESPONDER_DID, "peer", [], ["route-exchange"], iCb);
    const challenge = await handleHello(responder, hello.message, [], [], rCb);

    expect(challenge.ok).toBe(false);
    if (challenge.ok) return;
    expect(challenge.state.phase).toBe("failed");
    expect(challenge.error).toContain("Policy denied");
  });

  it("rejects CHALLENGE in wrong phase", async () => {
    const state = createHandshake(INITIATOR_DID);
    const cb = stubCallbacks();

    const result = await handleChallenge(state, {
      type: "CHALLENGE",
      collectiveDid: RESPONDER_DID,
      nonce: "test",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      acceptedType: "peer",
      acceptedCidrs: [],
      acceptedCapabilities: [],
      negotiatedVersion: "1.0.0",
      negotiatedKeepaliveSeconds: 60,
      signature: "sig",
      timestamp: new Date().toISOString(),
    }, cb);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Unexpected CHALLENGE");
  });

  it("rejects COMMIT with wrong nonce", async () => {
    const initiator = createHandshake(INITIATOR_DID);
    const responder = createHandshake(RESPONDER_DID);
    const iCb = stubCallbacks();
    const rCb = stubCallbacks();

    const hello = await initiateHello(initiator, RESPONDER_DID, "peer", [], ["route-exchange"], iCb);
    const challenge = await handleHello(responder, hello.message, [], [], rCb);
    expect(challenge.ok).toBe(true);
    if (!challenge.ok) return;

    const badCommit = await handleCommit(challenge.state, {
      type: "COMMIT",
      collectiveDid: INITIATOR_DID,
      challengeNonce: "wrong-nonce",
      challengeSignature: "sig",
      initialRoutes: [],
      signature: "sig",
      timestamp: new Date().toISOString(),
    }, rCb);

    expect(badCommit.ok).toBe(false);
    if (badCommit.ok) return;
    expect(badCommit.error).toContain("nonce mismatch");
  });

  it("rejects ESTABLISHED in wrong phase", () => {
    const state = createHandshake(INITIATOR_DID);
    const result = handleEstablished(state, {
      type: "ESTABLISHED",
      sessionId: "abc",
      collectiveDid: RESPONDER_DID,
      initialRoutes: [],
      keepaliveIntervalSeconds: 60,
      signature: "",
      timestamp: new Date().toISOString(),
    });
    expect(result.phase).toBe("failed");
  });

  it("negotiates common capabilities only", async () => {
    const initiator = createHandshake(INITIATOR_DID);
    const responder = createHandshake(RESPONDER_DID);
    const iCb = stubCallbacks();
    const rCb = stubCallbacks();

    const hello = await initiateHello(
      initiator,
      RESPONDER_DID,
      "peer",
      [],
      ["route-exchange", "mesh"],
      iCb,
    );
    const challenge = await handleHello(
      responder,
      hello.message,
      [],
      ["route-exchange", "dns-forward", "transit"],
      rCb,
    );
    expect(challenge.ok).toBe(true);
    if (!challenge.ok) return;
    expect(challenge.message.acceptedCapabilities).toEqual(["route-exchange"]);
  });
});
