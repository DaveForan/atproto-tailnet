/** The app sends HSTS itself on a public https deployment (a proxy other than Caddy may not). */
import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { securityHeaders } from "../security-headers.js";

function headersOf(publicUrl: string, loopback: boolean): Record<string, string> {
  const set: Record<string, string> = {};
  const res = { setHeader: (k: string, v: string) => (set[k] = v) } as unknown as Response;
  const next = vi.fn();
  securityHeaders(publicUrl, loopback)({} as Request, res, next);
  expect(next).toHaveBeenCalled();
  return set;
}

describe("security headers", () => {
  it("sends HSTS for a public https URL", () => {
    expect(headersOf("https://tailnet.example.com", false)["Strict-Transport-Security"]).toBe("max-age=31536000");
  });

  it("sends no HSTS over http or on loopback", () => {
    expect(headersOf("http://tailnet.example.com", false)["Strict-Transport-Security"]).toBeUndefined();
    expect(headersOf("https://localhost:3000", true)["Strict-Transport-Security"]).toBeUndefined();
  });

  it("always sends the CSP and framing headers", () => {
    const h = headersOf("http://localhost:3000", true);
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
  });
});
