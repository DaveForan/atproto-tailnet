/**
 * Tests for the permission constants and types.
 *
 * Ensures ALL_PERMISSIONS stays at the documented count, PERMISSION_LABELS
 * covers every entry, and ORIGINATOR_PERMISSIONS mirrors the full set.
 */

import { describe, it, expect } from "vitest";
import {
  ALL_PERMISSIONS,
  PERMISSION_LABELS,
  ORIGINATOR_PERMISSIONS,
  DEFAULT_CITIZEN_PERMISSIONS,
} from "../routes/permissions.js";

describe("ALL_PERMISSIONS", () => {
  it("contains exactly 16 permissions", () => {
    expect(ALL_PERMISSIONS).toHaveLength(16);
  });

  it("has no duplicate entries", () => {
    const unique = new Set(ALL_PERMISSIONS);
    expect(unique.size).toBe(ALL_PERMISSIONS.length);
  });

  it("contains every expected permission", () => {
    const expected = [
      "invite",
      "kick",
      "manage_roles",
      "manage_settings",
      "approve_devices",
      "approve_joins",
      "approve_services",
      "lock_devices",
      "view_audit_log",
      "manage_devices",
      "manage_services",
      "manage_board",
      "create_posts",
      "create_agent_tokens",
      "manage_agent_tokens",
      "manage_acl",
    ];
    for (const perm of expected) {
      expect(ALL_PERMISSIONS).toContain(perm);
    }
  });
});

describe("PERMISSION_LABELS", () => {
  it("has a label for every permission in ALL_PERMISSIONS", () => {
    for (const perm of ALL_PERMISSIONS) {
      expect(PERMISSION_LABELS).toHaveProperty(perm);
      expect(typeof PERMISSION_LABELS[perm]).toBe("string");
      expect(PERMISSION_LABELS[perm].length).toBeGreaterThan(0);
    }
  });

  it("has no extra keys beyond ALL_PERMISSIONS", () => {
    const labelKeys = Object.keys(PERMISSION_LABELS);
    expect(labelKeys).toHaveLength(ALL_PERMISSIONS.length);
    for (const key of labelKeys) {
      expect(ALL_PERMISSIONS).toContain(key);
    }
  });
});

describe("ORIGINATOR_PERMISSIONS", () => {
  it("matches ALL_PERMISSIONS exactly", () => {
    expect([...ORIGINATOR_PERMISSIONS]).toEqual([...ALL_PERMISSIONS]);
  });

  it("is the same reference as ALL_PERMISSIONS", () => {
    expect(ORIGINATOR_PERMISSIONS).toBe(ALL_PERMISSIONS);
  });
});

describe("DEFAULT_CITIZEN_PERMISSIONS", () => {
  it("is an empty array", () => {
    expect(DEFAULT_CITIZEN_PERMISSIONS).toHaveLength(0);
  });
});
