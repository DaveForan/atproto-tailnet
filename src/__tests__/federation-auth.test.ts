import { describe, it, expect } from "vitest";
import * as crypto from "node:crypto";
import type { PublicKeyResolver } from "../credentials/verifier.js";
import { signDetached } from "../identity/keys.js";
import {
  buildAnnouncements,
  filterImportedPrefixes,
  isFresh,
  makeHandshakeCallbacks,
  signMessage,
  signedPayload,
  verifyMessage,
  MAX_MESSAGE_SKEW_MS,
} from "../federation/auth.js";
import {
  createHandshake,
  initiateHello,
  handleHello,
  handleChallenge,
  handleCommit,
  handleEstablished,
} from "../federation/handshake.js";
import type { RouteAnnouncement } from "../federation/protocol.js";

const ALPHA = "did:web:alpha.example.com";
const BETA = "did:web:beta.example.com";
const MALLORY = "did:web:mallory.example.com";

function party(did: string) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    did,
    publicKey,
    sign: async (payload: string) => signDetached(privateKey, payload),
  };
}

const alpha = party(ALPHA);
const beta = party(BETA);
const mallory = party(MALLORY);

const resolver: PublicKeyResolver = {
  resolve: async (did) =>
    ({ [ALPHA]: alpha.publicKey, [BETA]: beta.publicKey, [MALLORY]: mallory.publicKey })[did] ?? null,
};

/** What an HTTP hop does to a message. */
const wire = <T>(message: T): T => JSON.parse(JSON.stringify(message));

async function callbacksFor(p: ReturnType<typeof party>, cidrs: string[], allow = true) {
  return makeHandshakeCallbacks({
    sign: p.sign,
    resolver,
    evaluatePolicy: async () => allow,
    routes: await buildAnnouncements(p.did, cidrs, p.sign),
  });
}

describe("CFP handshake with real signatures", () => {
  it("completes end to end and both sides can authenticate every reply", async () => {
    const aCb = await callbacksFor(alpha, ["10.1.0.0/24"]);
    const bCb = await callbacksFor(beta, ["10.2.0.0/24"]);

    const hello = await initiateHello(
      createHandshake(ALPHA), BETA, "peer", ["10.1.0.0/24"], ["route-exchange"], aCb,
    );
    const challenge = await handleHello(
      createHandshake(BETA), wire(hello.message), ["10.2.0.0/24"], ["route-exchange"], bCb,
    );
    expect(challenge.ok).toBe(true);
    if (!challenge.ok) return;

    const challengeMsg = wire(challenge.message);
    expect(await verifyMessage(resolver, BETA, challengeMsg)).toBe(true);

    const commit = await handleChallenge(hello.state, challengeMsg, aCb);
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;

    const established = await handleCommit(challenge.state, wire(commit.message), bCb);
    expect(established.ok).toBe(true);
    if (!established.ok) return;

    const establishedMsg = wire(established.message);
    expect(await verifyMessage(resolver, BETA, establishedMsg)).toBe(true);

    const final = handleEstablished(commit.state, establishedMsg);
    expect(final.phase).toBe("established");
    expect(final.sessionId).toBe(established.state.sessionId);

    expect(filterImportedPrefixes(establishedMsg.initialRoutes, ["10.2.0.0/24"], BETA)).toEqual(["10.2.0.0/24"]);
    expect(filterImportedPrefixes(commit.message.initialRoutes, ["10.1.0.0/24"], ALPHA)).toEqual(["10.1.0.0/24"]);
  });

  it("rejects a HELLO signed by a different key than its claimed DID", async () => {
    const forged = await initiateHello(
      createHandshake(ALPHA), BETA, "peer", [], ["route-exchange"], await callbacksFor(mallory, []),
    );
    const result = await handleHello(
      createHandshake(BETA), wire(forged.message), [], ["route-exchange"], await callbacksFor(beta, []),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("signature");
  });

  it("rejects a HELLO altered in transit", async () => {
    const hello = await initiateHello(
      createHandshake(ALPHA), BETA, "peer", ["10.1.0.0/24"], ["route-exchange"], await callbacksFor(alpha, []),
    );
    const altered = { ...wire(hello.message), offeredCidrs: ["0.0.0.0/0"] };
    const result = await handleHello(
      createHandshake(BETA), altered, [], ["route-exchange"], await callbacksFor(beta, []),
    );
    expect(result.ok).toBe(false);
  });

  it("denies a correctly signed HELLO when policy refuses the peer", async () => {
    const hello = await initiateHello(
      createHandshake(MALLORY), BETA, "peer", [], ["route-exchange"], await callbacksFor(mallory, []),
    );
    const result = await handleHello(
      createHandshake(BETA), wire(hello.message), [], ["route-exchange"], await callbacksFor(beta, [], false),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Policy");
  });

  it("rejects a COMMIT whose nonce was signed by someone else", async () => {
    const aCb = await callbacksFor(alpha, []);
    const bCb = await callbacksFor(beta, []);
    const hello = await initiateHello(createHandshake(ALPHA), BETA, "peer", [], ["route-exchange"], aCb);
    const challenge = await handleHello(createHandshake(BETA), wire(hello.message), [], ["route-exchange"], bCb);
    if (!challenge.ok) throw new Error("setup failed");

    // Mallory replays alpha's HELLO, gets the challenge, and answers as alpha.
    const stolen = await handleChallenge(hello.state, wire(challenge.message), await callbacksFor(mallory, []));
    if (!stolen.ok) throw new Error("setup failed");
    const result = await handleCommit(challenge.state, wire(stolen.message), bCb);
    expect(result.ok).toBe(false);
  });
});

describe("message signing", () => {
  it("signs session messages so the peer can verify them after transport", async () => {
    const keepalive = await signMessage(
      { type: "KEEPALIVE" as const, sessionId: "s1", sequenceNumber: 7, timestamp: new Date().toISOString() },
      alpha.sign,
    );
    expect(await verifyMessage(resolver, ALPHA, wire(keepalive))).toBe(true);
    expect(await verifyMessage(resolver, BETA, wire(keepalive))).toBe(false);
    expect(await verifyMessage(resolver, ALPHA, { ...wire(keepalive), sessionId: "s2" })).toBe(false);
    expect(await verifyMessage(resolver, "did:web:unknown.example.com", wire(keepalive))).toBe(false);
  });

  it("refuses unsigned messages", async () => {
    expect(await verifyMessage(resolver, ALPHA, { signature: "" })).toBe(false);
    expect(await verifyMessage(resolver, ALPHA, {})).toBe(false);
  });

  it("excludes the signature from the signed payload", () => {
    expect(signedPayload({ a: 1, signature: "x", b: 2 })).toBe('{"a":1,"b":2}');
  });

  it("only accepts timestamps close to now", () => {
    const now = Date.now();
    expect(isFresh(new Date(now).toISOString(), now)).toBe(true);
    expect(isFresh(new Date(now - MAX_MESSAGE_SKEW_MS - 1000).toISOString(), now)).toBe(false);
    expect(isFresh(new Date(now + MAX_MESSAGE_SKEW_MS + 1000).toISOString(), now)).toBe(false);
    expect(isFresh("not a date", now)).toBe(false);
  });
});

describe("filterImportedPrefixes", () => {
  const ann = (prefix: string, originDid = BETA): RouteAnnouncement => ({
    prefix, originDid, pathVector: [originDid], preference: 100, originSignature: "",
  });

  it("imports only CIDRs agreed on the link", () => {
    expect(
      filterImportedPrefixes(
        [ann("10.2.0.0/24"), ann("0.0.0.0/0"), ann("10.0.0.0/8"), ann("192.168.0.0/24")],
        ["10.2.0.0/24"],
        BETA,
      ),
    ).toEqual(["10.2.0.0/24"]);
  });

  it("drops routes the peer does not originate, and duplicates", () => {
    expect(
      filterImportedPrefixes(
        [ann("10.2.0.0/24", MALLORY), ann("10.3.0.0/24"), ann("10.3.0.0/24")],
        ["10.2.0.0/24", "10.3.0.0/24"],
        BETA,
      ),
    ).toEqual(["10.3.0.0/24"]);
  });

  it("imports nothing when nothing was announced", () => {
    expect(filterImportedPrefixes(undefined, ["10.2.0.0/24"], BETA)).toEqual([]);
  });
});
