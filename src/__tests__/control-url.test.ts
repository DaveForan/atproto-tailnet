/** Shared control URL (ADR-0026 §3): one login server for every tailnet. */
import { describe, it, expect, vi } from "vitest";

vi.hoisted(() => {
  process.env.PUBLIC_URL = "https://tailnets.example.com";
  process.env.SESSION_SECRET = "s".repeat(48);
  process.env.BASE_DOMAIN = "ts.example.com";
  process.env.CONTROL_DOMAIN = "control.example.com";
  process.env.COORDINATOR_URL = "http://coordinator:9443";
  process.env.COORDINATOR_API_KEY = "k".repeat(40);
});

vi.mock("../db/index.js", () => ({ db: {}, pool: {} }));

import { sessionCookieName, sharedControlUrl } from "../config.js";
import { tenantLoginServerFor, usesSharedControlUrl } from "../orchestrator/hostnames.js";

describe("shared control URL", () => {
  it("is built from CONTROL_DOMAIN with the public scheme", () => {
    expect(sharedControlUrl()).toBe("https://control.example.com");
    expect(usesSharedControlUrl()).toBe(true);
  });

  it("is every tailnet's login server, without touching the DB", async () => {
    expect(await tenantLoginServerFor({ id: "t-1", slug: "t-abc" })).toBe("https://control.example.com");
    expect(await tenantLoginServerFor({ id: "t-2", slug: "t-def" })).toBe("https://control.example.com");
  });
});

describe("CONTROL_DOMAIN validation", () => {
  it("refuses a control host under BASE_DOMAIN", async () => {
    vi.resetModules();
    process.env.CONTROL_DOMAIN = "control.ts.example.com";
    await expect(import("../config.js")).rejects.toThrow(/must not be BASE_DOMAIN/);
    process.env.CONTROL_DOMAIN = "control.example.com";
  });
});

describe("session cookie name", () => {
  it("uses the __Host- prefix over HTTPS so subdomains cannot set it", () => {
    expect(sessionCookieName("https://tailnets.example.com")).toBe("__Host-tailnet-session");
    expect(sessionCookieName()).toMatch(/^__Host-/);
  });
  it("has no prefix over plain HTTP (browsers would refuse it)", () => {
    expect(sessionCookieName("http://127.0.0.1:3000")).toBe("tailnet-session");
  });
});
