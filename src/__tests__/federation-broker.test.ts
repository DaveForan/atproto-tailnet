import { describe, it, expect } from "vitest";
import {
  FEDERATION_RELAY_TAG,
  addFederatedRoutesToPolicy,
  removeFederatedRoutesFromPolicy,
  linkSide,
} from "../orchestrator/federation-broker.js";

const link = {
  requesterTenantId: "req",
  targetTenantId: "tgt",
  requesterCidrs: ["10.1.0.0/24"],
  targetCidrs: ["10.2.0.0/24"],
  requesterBrokerEndpoint: null,
  targetBrokerEndpoint: null,
};

describe("linkSide", () => {
  it("gives each tenant its own view of the link", () => {
    expect(linkSide(link, "req", "https://self.example.com")).toEqual({
      localTenantId: "req",
      remoteTenantId: "tgt",
      localCidrs: ["10.1.0.0/24"],
      remoteCidrs: ["10.2.0.0/24"],
      remoteEndpoint: "https://self.example.com",
    });
    expect(linkSide(link, "tgt", "https://self.example.com")).toMatchObject({
      remoteTenantId: "req",
      localCidrs: ["10.2.0.0/24"],
      remoteCidrs: ["10.1.0.0/24"],
    });
  });

  it("uses the peer's recorded broker endpoint when there is one", () => {
    const remote = { ...link, requesterBrokerEndpoint: "https://req.example.com" };
    expect(linkSide(remote, "tgt", "https://self.example.com").remoteEndpoint).toBe("https://req.example.com");
    expect(linkSide(remote, "req", "https://self.example.com").remoteEndpoint).toBe("https://self.example.com");
  });
});

describe("federated route policy edits", () => {
  it("approves federated CIDRs for the relay tag only, and declares the tag", () => {
    const policy = addFederatedRoutesToPolicy({ acls: [{ action: "accept" }] }, ["10.2.0.0/24"]);
    expect(policy.autoApprovers?.routes).toEqual({ "10.2.0.0/24": [FEDERATION_RELAY_TAG] });
    expect(policy.tagOwners).toEqual({ [FEDERATION_RELAY_TAG]: [] });
    expect(policy.acls).toEqual([{ action: "accept" }]);
  });

  it("preserves existing approvers, tag owners and exit-node settings", () => {
    const before = {
      tagOwners: { [FEDERATION_RELAY_TAG]: ["group:ops"], "tag:web": ["alice@"] },
      autoApprovers: { routes: { "10.2.0.0/24": ["group:ops"] }, exitNode: ["tag:exit"] },
    };
    const after = addFederatedRoutesToPolicy(before, ["10.2.0.0/24"]);
    expect(after.autoApprovers?.routes?.["10.2.0.0/24"]).toEqual(["group:ops", FEDERATION_RELAY_TAG]);
    expect(after.tagOwners).toEqual(before.tagOwners);
    expect(after.autoApprovers?.exitNode).toEqual(["tag:exit"]);
    // Input is not mutated.
    expect(before.autoApprovers.routes["10.2.0.0/24"]).toEqual(["group:ops"]);
  });

  it("is idempotent", () => {
    const once = addFederatedRoutesToPolicy({}, ["10.2.0.0/24"]);
    expect(addFederatedRoutesToPolicy(once, ["10.2.0.0/24"])).toEqual(once);
  });

  it("removes only what it added", () => {
    const policy = addFederatedRoutesToPolicy(
      { autoApprovers: { routes: { "10.2.0.0/24": ["group:ops"], "10.9.0.0/24": ["group:ops"] } } },
      ["10.2.0.0/24", "10.3.0.0/24"],
    );
    const after = removeFederatedRoutesFromPolicy(policy, ["10.2.0.0/24", "10.3.0.0/24"]);
    expect(after.autoApprovers?.routes).toEqual({
      "10.2.0.0/24": ["group:ops"],
      "10.9.0.0/24": ["group:ops"],
    });
  });
});
