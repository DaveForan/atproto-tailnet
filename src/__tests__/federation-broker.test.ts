import { describe, it, expect } from "vitest";
import {
  FEDERATION_RELAY_TAG,
  addFederatedRoutesToPolicy,
  removeFederatedRoutesFromPolicy,
} from "../orchestrator/federation-broker.js";

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
