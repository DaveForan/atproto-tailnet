/**
 * Tests for generateHeadscaleConfig from the Headscale orchestrator.
 *
 * These are pure-function tests: generateHeadscaleConfig builds a YAML
 * config string from inputs + the app config defaults (baseDomain, publicUrl).
 */

import { describe, it, expect } from "vitest";
import { generateHeadscaleConfig } from "../orchestrator/headscale.js";

/**
 * Helper: parse the generated YAML-like config string into a map of
 * key lines for quick assertions. Not a full YAML parser -- just
 * enough to check specific lines.
 */
function configLines(yaml: string): string[] {
  return yaml.split("\n");
}

describe("generateHeadscaleConfig", () => {
  describe("default config", () => {
    const yaml = generateHeadscaleConfig("my-tenant", 10042);
    const lines = configLines(yaml);

    it("starts with YAML document marker", () => {
      expect(lines[0]).toBe("---");
    });

    it("sets server_url using slug and baseDomain", () => {
      const serverUrlLine = lines.find((l) => l.startsWith("server_url:"));
      expect(serverUrlLine).toBeDefined();
      expect(serverUrlLine).toContain("my-tenant");
      // baseDomain defaults to "ts.localhost"
      expect(serverUrlLine).toContain("ts.localhost");
    });

    it("uses http protocol when publicUrl is http", () => {
      // default publicUrl is "http://localhost:3000"
      const serverUrlLine = lines.find((l) => l.startsWith("server_url:"));
      expect(serverUrlLine).toMatch(/^server_url: http:\/\//);
    });

    it("listens on 0.0.0.0:8080", () => {
      expect(lines).toContain("listen_addr: 0.0.0.0:8080");
    });

    it("has metrics on port 9090", () => {
      expect(lines).toContain("metrics_listen_addr: 0.0.0.0:9090");
    });

    it("disables embedded DERP server by default", () => {
      const derpLine = lines.find((l) => l.trim().startsWith("enabled:"));
      expect(derpLine).toBeDefined();
      expect(derpLine!.trim()).toBe("enabled: false");
    });

    it("includes public DERP URL by default", () => {
      const derpUrlLine = lines.find((l) =>
        l.includes("controlplane.tailscale.com/derpmap/default"),
      );
      expect(derpUrlLine).toBeDefined();
    });

    it("does not include custom DERP paths by default", () => {
      const pathsLine = lines.find((l) => l.includes("derp-custom.yaml"));
      expect(pathsLine).toBeUndefined();
    });

    it("uses default IP prefixes", () => {
      const v4Line = lines.find((l) => l.trim().startsWith("v4:"));
      const v6Line = lines.find((l) => l.trim().startsWith("v6:"));
      expect(v4Line).toBeDefined();
      expect(v4Line!.trim()).toBe("v4: 100.64.0.0/10");
      expect(v6Line).toBeDefined();
      expect(v6Line!.trim()).toBe("v6: fd7a:115c:a1e0::/48");
    });

    it("uses sequential allocation by default", () => {
      const allocLine = lines.find((l) => l.trim().startsWith("allocation:"));
      expect(allocLine).toBeDefined();
      expect(allocLine!.trim()).toBe("allocation: sequential");
    });

    it("uses sqlite database", () => {
      const dbTypeLine = lines.find((l) => l.trim() === "type: sqlite");
      expect(dbTypeLine).toBeDefined();
    });

    it("sets magic_dns and base_domain with slug", () => {
      const magicLine = lines.find((l) => l.trim() === "magic_dns: true");
      expect(magicLine).toBeDefined();
      const baseDomainLine = lines.find((l) =>
        l.trim().startsWith("base_domain:"),
      );
      expect(baseDomainLine).toBeDefined();
      expect(baseDomainLine).toContain("my-tenant.tailnet.local");
    });

    it("uses 24h update frequency without custom regions", () => {
      const freqLine = lines.find((l) =>
        l.trim().startsWith("update_frequency:"),
      );
      expect(freqLine).toBeDefined();
      expect(freqLine!.trim()).toBe("update_frequency: 24h");
    });

    it("uses database policy mode", () => {
      const policyLine = lines.find((l) => l.trim() === "mode: database");
      expect(policyLine).toBeDefined();
    });
  });

  describe("custom DERP options", () => {
    it("enables embedded DERP server when requested", () => {
      const yaml = generateHeadscaleConfig("derp-tenant", 10050, {
        derp: { embeddedDerpEnabled: true },
      });
      const lines = configLines(yaml);
      const enabledLine = lines.find((l) => l.trim().startsWith("enabled:"));
      expect(enabledLine!.trim()).toBe("enabled: true");
    });

    it("removes public DERP URLs when usePublicDerp is false", () => {
      const yaml = generateHeadscaleConfig("private-tenant", 10051, {
        derp: { usePublicDerp: false },
      });
      const lines = configLines(yaml);
      // Should have "urls: []" instead of the public URL
      const urlsLine = lines.find((l) => l.trim().startsWith("urls:"));
      expect(urlsLine).toBeDefined();
      expect(urlsLine!.trim()).toBe("urls: []");
      const publicDerpLine = lines.find((l) =>
        l.includes("controlplane.tailscale.com"),
      );
      expect(publicDerpLine).toBeUndefined();
    });

    it("includes custom DERP paths when hasCustomRegions is true", () => {
      const yaml = generateHeadscaleConfig("custom-tenant", 10052, {
        derp: { hasCustomRegions: true },
      });
      const lines = configLines(yaml);
      const pathsLine = lines.find((l) =>
        l.includes("derp-custom.yaml"),
      );
      expect(pathsLine).toBeDefined();
    });

    it("uses 5m update frequency with custom regions", () => {
      const yaml = generateHeadscaleConfig("fast-update", 10053, {
        derp: { hasCustomRegions: true },
      });
      const lines = configLines(yaml);
      const freqLine = lines.find((l) =>
        l.trim().startsWith("update_frequency:"),
      );
      expect(freqLine!.trim()).toBe("update_frequency: 5m");
    });
  });

  describe("custom IP prefixes", () => {
    it("uses custom IPv4 prefix when provided", () => {
      const yaml = generateHeadscaleConfig("ip-tenant", 10060, {
        ipv4Prefix: "10.0.0.0/8",
      });
      const lines = configLines(yaml);
      const v4Line = lines.find((l) => l.trim().startsWith("v4:"));
      expect(v4Line!.trim()).toBe("v4: 10.0.0.0/8");
    });

    it("uses custom IPv6 prefix when provided", () => {
      const yaml = generateHeadscaleConfig("ip6-tenant", 10061, {
        ipv6Prefix: "fd00::/64",
      });
      const lines = configLines(yaml);
      const v6Line = lines.find((l) => l.trim().startsWith("v6:"));
      expect(v6Line!.trim()).toBe("v6: fd00::/64");
    });

    it("uses random allocation when specified", () => {
      const yaml = generateHeadscaleConfig("random-tenant", 10062, {
        ipAllocation: "random",
      });
      const lines = configLines(yaml);
      const allocLine = lines.find((l) =>
        l.trim().startsWith("allocation:"),
      );
      expect(allocLine!.trim()).toBe("allocation: random");
    });
  });

  describe("slug and port in output", () => {
    it("slug appears in server_url", () => {
      const yaml = generateHeadscaleConfig("acme-corp", 10070);
      expect(yaml).toContain("server_url: http://acme-corp.ts.localhost");
    });

    it("slug appears in dns.base_domain", () => {
      const yaml = generateHeadscaleConfig("acme-corp", 10070);
      expect(yaml).toContain("base_domain: acme-corp.tailnet.local");
    });
  });
});
