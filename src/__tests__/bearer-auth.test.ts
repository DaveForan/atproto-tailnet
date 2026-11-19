/**
 * resolveAgentToken: a Bearer header that does not resolve to a credential is
 * refused with 401 and never falls back to the session cookie (the CSRF
 * middleware exempts Bearer requests, so a fallback would bypass CSRF).
 */
import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../db/index.js", () => ({
  db: {
    // No agent token row matches
    select: vi.fn(() => ({ from: () => ({ where: async () => [] }) })),
    update: vi.fn(),
  },
}));

import { resolveAgentToken } from "../routes/helpers.js";

function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    set() {
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
  };
  return res;
}

function fakeReq(authorization?: string): Request {
  return {
    headers: authorization ? { authorization } : {},
    session: { userId: "u-victim", did: "did:plc:victim" },
  } as unknown as Request;
}

describe("resolveAgentToken", () => {
  it("passes requests without a Bearer header straight through", async () => {
    const res = fakeRes();
    const next = vi.fn();
    await resolveAgentToken(fakeReq(), res as unknown as Response, next);
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it("refuses an unknown agent token with 401 even when a session cookie is present", async () => {
    const res = fakeRes();
    const next = vi.fn();
    await resolveAgentToken(fakeReq("Bearer at_doesnotexist"), res as unknown as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("refuses garbage Bearer values with 401", async () => {
    const res = fakeRes();
    const next = vi.fn();
    await resolveAgentToken(fakeReq("Bearer x"), res as unknown as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});
