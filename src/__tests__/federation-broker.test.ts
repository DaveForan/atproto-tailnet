import { describe, it, expect } from "vitest";
import {
  FEDERATION_RELAY_TAG,
  addFederatedRoutesToAutoApprovers,
  normalizeAutoApprovers,
  reconcileFederatedAutoApprovers,
  removeFederatedRoutesFromAutoApprovers,
  handshakeRetryDelayMs,
} from "../orchestrator/federation-broker.js";

describe("handshakeRetryDelayMs", () => {
  it("backs off exponentially from 30s and caps at 30 minutes", () => {
    const mid = () => 0.5;
    expect(handshakeRetryDelayMs(1, mid)).toBe(30_000);
    expect(handshakeRetryDelayMs(2, mid)).toBe(60_000);
    expect(handshakeRetryDelayMs(4, mid)).toBe(240_000);
    expect(handshakeRetryDelayMs(50, mid)).toBe(30 * 60_000);
    expect(handshakeRetryDelayMs(1, () => 0)).toBe(24_000);
    expect(handshakeRetryDelayMs(1, () => 1)).toBe(36_000);
  });
});

describe("coordinator auto-approvers for federated routes", () => {
  const base = {
    routes: { "10.9.0.0/24": ["tag:ops"], "10.2.0.0/24": ["tag:ops"] },
    exit_node: ["tag:exit"],
  };

  it("approves imported CIDRs for the relay tag and keeps other entries", () => {
    const after = addFederatedRoutesToAutoApprovers(base, ["10.2.0.0/24", "10.3.0.0/24"]);
    expect(after.routes).toEqual({
      "10.9.0.0/24": ["tag:ops"],
      "10.2.0.0/24": ["tag:ops", FEDERATION_RELAY_TAG],
      "10.3.0.0/24": [FEDERATION_RELAY_TAG],
    });
    expect(after.exit_node).toEqual(["tag:exit"]);
    expect(base.routes["10.2.0.0/24"]).toEqual(["tag:ops"]);
    expect(addFederatedRoutesToAutoApprovers(after, ["10.3.0.0/24"])).toEqual(after);
  });

  it("withdraws only the relay tag", () => {
    const added = addFederatedRoutesToAutoApprovers(base, ["10.2.0.0/24", "10.3.0.0/24"]);
    expect(removeFederatedRoutesFromAutoApprovers(added, ["10.2.0.0/24", "10.3.0.0/24"])).toEqual(base);
  });

  it("reconciles to exactly the imported set (coordinator restart / overwrite)", () => {
    const stale = addFederatedRoutesToAutoApprovers(base, ["10.4.0.0/24"]);
    const fixed = reconcileFederatedAutoApprovers(stale, ["10.5.0.0/24"]);
    expect(fixed.routes).toEqual({ ...base.routes, "10.5.0.0/24": [FEDERATION_RELAY_TAG] });
    expect(reconcileFederatedAutoApprovers(normalizeAutoApprovers(undefined), [])).toEqual({ routes: {}, exit_node: [] });
  });
});
