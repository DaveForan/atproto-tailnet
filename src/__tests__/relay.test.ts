import { describe, it, expect } from "vitest";
import {
  relayContainerName,
  relayNetworkName,
  buildForwardRules,
} from "../orchestrator/relay.js";

describe("relayContainerName", () => {
  it("formats container name with link id and side", () => {
    expect(relayContainerName("abc-123", "local")).toBe("relay-abc-123-local");
    expect(relayContainerName("abc-123", "peer")).toBe("relay-abc-123-peer");
  });
});

describe("relayNetworkName", () => {
  it("formats network name with link id", () => {
    expect(relayNetworkName("abc-123")).toBe("fed-link-abc-123");
  });
});

describe("buildForwardRules", () => {
  it("generates iptables FORWARD rules for local and peer CIDRs", () => {
    const rules = buildForwardRules(
      ["100.64.1.0/24"],
      ["100.64.2.0/24"],
    );
    expect(rules).toContain("iptables -P FORWARD DROP");
    expect(rules).toContain("iptables -A FORWARD -i tailscale0 -s 100.64.1.0/24 -d 100.64.2.0/24 -j ACCEPT");
    expect(rules).toContain("iptables -A FORWARD -i tailscale0 -s 100.64.2.0/24 -d 100.64.1.0/24 -j ACCEPT");
    expect(rules.some((r) => r.includes("ESTABLISHED,RELATED"))).toBe(true);
  });

  it("handles multiple CIDR pairs", () => {
    const rules = buildForwardRules(
      ["100.64.1.0/24", "100.64.3.0/24"],
      ["100.64.2.0/24"],
    );
    expect(rules).toContain("iptables -A FORWARD -i tailscale0 -s 100.64.1.0/24 -d 100.64.2.0/24 -j ACCEPT");
    expect(rules).toContain("iptables -A FORWARD -i tailscale0 -s 100.64.3.0/24 -d 100.64.2.0/24 -j ACCEPT");
    expect(rules.length).toBe(6);
  });

  it("produces only default policy for empty CIDR lists", () => {
    const rules = buildForwardRules([], []);
    expect(rules).toContain("iptables -P FORWARD DROP");
    expect(rules.filter((r) => r.includes("-A FORWARD -i"))).toHaveLength(0);
  });
});
