/** Drizzle schema: DerpRegion shape and enum value arrays. */

import { describe, it, expect } from "vitest";
import type { DerpRegion, DerpRegionNode } from "../db/schema.js";
import {
  tenantStatusEnum,
  invitationStatusEnum,
  auditActionEnum,
  deviceApprovalStatusEnum,
  joinRequestStatusEnum,
  agentTokenStatusEnum,
  federationStatusEnum,
} from "../db/schema.js";

describe("DerpRegion type shape", () => {
  it("accepts a valid DerpRegion object", () => {
    const region: DerpRegion = {
      regionId: 900,
      regionCode: "us-east",
      regionName: "US East",
      nodes: [
        {
          name: "node1",
          hostname: "derp1.example.com",
          stunPort: 3478,
          derpPort: 443,
        },
      ],
    };

    expect(region.regionId).toBe(900);
    expect(region.regionCode).toBe("us-east");
    expect(region.regionName).toBe("US East");
    expect(region.nodes).toHaveLength(1);
    expect(region.nodes[0].name).toBe("node1");
    expect(region.nodes[0].hostname).toBe("derp1.example.com");
  });

  it("allows optional stunPort and derpPort on nodes", () => {
    const node: DerpRegionNode = {
      name: "minimal-node",
      hostname: "derp.example.com",
    };

    expect(node.stunPort).toBeUndefined();
    expect(node.derpPort).toBeUndefined();
  });

  it("allows nodes array to contain multiple entries", () => {
    const region: DerpRegion = {
      regionId: 901,
      regionCode: "eu",
      regionName: "Europe",
      nodes: [
        { name: "eu1", hostname: "eu1.example.com" },
        { name: "eu2", hostname: "eu2.example.com", stunPort: 3478 },
        { name: "eu3", hostname: "eu3.example.com", derpPort: 443 },
      ],
    };

    expect(region.nodes).toHaveLength(3);
  });
});

describe("enum value arrays have no duplicates", () => {
  const enums: Record<string, { enumValues: readonly string[] }> = {
    tenantStatusEnum,
    invitationStatusEnum,
    auditActionEnum,
    deviceApprovalStatusEnum,
    joinRequestStatusEnum,
    agentTokenStatusEnum,
    federationStatusEnum,
  };

  for (const [name, pgEnumDef] of Object.entries(enums)) {
    it(`${name} has no duplicate values`, () => {
      const values = pgEnumDef.enumValues;
      const unique = new Set(values);
      expect(unique.size).toBe(values.length);
    });
  }

  it("tenantStatusEnum has the expected values", () => {
    expect([...tenantStatusEnum.enumValues]).toEqual([
      "provisioning",
      "running",
      "stopped",
      "error",
      "deleted",
    ]);
  });

  it("federationStatusEnum has the expected values", () => {
    expect([...federationStatusEnum.enumValues]).toEqual([
      "pending",
      "active",
      "rejected",
      "revoked",
    ]);
  });

  it("agentTokenStatusEnum has the expected values", () => {
    expect([...agentTokenStatusEnum.enumValues]).toEqual([
      "active",
      "revoked",
    ]);
  });
});

describe("legacy schema", () => {
  it("no longer exports the dropped tables and enums", async () => {
    const schema: Record<string, unknown> = await import("../db/schema.js");
    for (const name of ["services", "serviceDevices", "boardPosts", "serviceStatusEnum", "serviceDeviceStatusEnum", "boardPostStatusEnum", "memberRoleEnum"]) {
      expect(schema[name]).toBeUndefined();
    }
    expect("role" in (schema.memberships as object)).toBe(false);
  });
});
