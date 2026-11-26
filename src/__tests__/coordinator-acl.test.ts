import { describe, it, expect } from "vitest";
import {
  aclPolicyFileToCoordinator,
  coordinatorToAclPolicyFile,
  AclTranslationError,
} from "../orchestrator/coordinator-acl.js";

describe("aclPolicyFileToCoordinator", () => {
  it("translates the default allow-all policy", () => {
    expect(
      aclPolicyFileToCoordinator({ acls: [{ action: "accept", src: ["*"], dst: ["*:*"] }] }),
    ).toEqual({ default_deny: true, rules: [{ src: "*", dst: "*", ports: ["All"] }] });
  });

  it("empty acls deny everything", () => {
    expect(aclPolicyFileToCoordinator({ acls: [], groups: {}, hosts: {} })).toEqual({
      default_deny: true,
      rules: [],
    });
  });

  it("expands src x dst, resolves hosts and parses ports", () => {
    const out = aclPolicyFileToCoordinator({
      acls: [{ action: "accept", src: ["10.0.0.0/8", "web"], dst: ["db:5432", "[fd7a::1]:80,443,1000-2000"] }],
      hosts: { web: "100.64.0.5", db: "100.64.0.6/32" },
      groups: {},
      tagOwners: {},
      autoApprovers: {},
    });
    expect(out.rules).toEqual([
      { src: "10.0.0.0/8", dst: "100.64.0.6/32", ports: [{ Single: 5432 }] },
      { src: "10.0.0.0/8", dst: "fd7a::1", ports: [{ Single: 80 }, { Single: 443 }, { Range: [1000, 2000] }] },
      { src: "100.64.0.5", dst: "100.64.0.6/32", ports: [{ Single: 5432 }] },
      { src: "100.64.0.5", dst: "fd7a::1", ports: [{ Single: 80 }, { Single: 443 }, { Range: [1000, 2000] }] },
    ]);
  });

  it.each([
    [{ acls: [{ action: "accept", src: ["alice"], dst: ["*:*"] }] }],
    [{ acls: [{ action: "accept", src: ["group:eng"], dst: ["*:*"] }] }],
    [{ acls: [{ action: "accept", src: ["*"], dst: ["tag:server:22"] }] }],
    [{ acls: [], groups: { "group:eng": ["alice"] } }],
    [{ acls: [], tagOwners: { "tag:x": ["alice"] } }],
    [{ acls: [], autoApprovers: { routes: { "10.0.0.0/8": ["tag:federation-relay"] } } }],
    [{ acls: [{ action: "accept", src: ["*"], dst: ["*:70000"] }] }],
    [{ acls: [], hosts: { bad: "not-an-ip" } }],
    [{ acls: [], ssh: [{ action: "accept" }] }],
  ])("rejects untranslatable policy %#", (policy) => {
    expect(() => aclPolicyFileToCoordinator(policy)).toThrow(AclTranslationError);
  });
});

describe("coordinatorToAclPolicyFile", () => {
  it("renders the coordinator's unset default as allow-all", () => {
    expect(
      coordinatorToAclPolicyFile({
        default_deny: false,
        rules: [{ src: "*", dst: "*", ports: [{ range: [0, 65535] }] }],
      }).acls,
    ).toEqual([{ action: "accept", src: ["*"], dst: ["*:*"] }]);
  });

  it("round-trips translated rules", () => {
    const policy = {
      acls: [{ action: "accept", src: ["10.0.0.0/8"], dst: ["100.64.0.6/32:22,80-90"] }],
    };
    const back = coordinatorToAclPolicyFile(aclPolicyFileToCoordinator(policy));
    expect(back.acls).toEqual(policy.acls);
    expect(aclPolicyFileToCoordinator(back)).toEqual(aclPolicyFileToCoordinator(policy));
  });

  it("renders default-deny with no rules as empty acls", () => {
    expect(coordinatorToAclPolicyFile({ default_deny: true, rules: [] }).acls).toEqual([]);
  });
});
