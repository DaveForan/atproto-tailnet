/**
 * Credential issuance is bounded: only members are subjects, a role
 * attestation never states more than the subject's role grants or the caller
 * holds, and a capability only delegates permissions both hold.
 *
 * DB is a chainable mock: each awaited query resolves to the next `results`
 * entry (same pattern as operator.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { AddressInfo } from "node:net";

const { results, chain, issueRoleAttestation, issueCapabilityToken, issueMembershipCredential } = vi.hoisted(() => {
  const results: unknown[] = [];
  function chain(): unknown {
    const proxy: unknown = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === "then") {
          const next = results.length ? results.shift() : [];
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(next).then(res, rej);
        }
        if (prop === "catch") return () => proxy;
        return () => proxy;
      },
    });
    return proxy;
  }
  const signed = { type: "x", jwt: "signed.jwt", issuedAt: "", expiresAt: "", issuerDid: "did:web:issuer" };
  return {
    results,
    chain,
    issueRoleAttestation: vi.fn(async () => signed),
    issueCapabilityToken: vi.fn(async () => signed),
    issueMembershipCredential: vi.fn(async () => signed),
  };
});

vi.mock("../db/index.js", () => ({
  db: { select: () => chain(), insert: () => chain(), update: () => chain(), delete: () => chain() },
  pool: {},
}));
vi.mock("../credentials/issuer.js", async (orig) => ({
  ...(await orig<typeof import("../credentials/issuer.js")>()),
  issueRoleAttestation,
  issueCapabilityToken,
  issueMembershipCredential,
}));
vi.mock("../orchestrator/federation-broker.js", () => ({
  loadCollectiveKeyPair: async () => ({ did: "did:web:issuer" }),
}));

import express from "express";
import type { Request, Response, NextFunction } from "express";
import { credentialsRouter } from "../routes/credentials.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const tenant = { id: TENANT, name: "T", slug: "t", lastActivityAt: new Date(), lockdownMode: false };
const callerRole = { id: "r-1", permissions: ["manage_settings", "invite", "create_posts"] };
const caller = [{ tenant, membership: { id: "m-1", isOriginator: false }, role: callerRole }];
const subjectWith = (permissions: string[]) => [{ membership: { id: "m-2", isOriginator: false }, role: { permissions } }];

const app = express();
app.use(express.json());
app.use((req: Request, _res: Response, next: NextFunction) => {
  (req as unknown as { session: Record<string, unknown> }).session = { userId: "u-1", did: "did:plc:caller" };
  if (req.headers["x-agent-scope"]) {
    const permissions = String(req.headers["x-agent-scope"]).split(",");
    (req as unknown as { agentToken: unknown }).agentToken = { id: "a", tenantId: TENANT, userId: "u-1", permissions };
  }
  next();
});
app.use(credentialsRouter);
const server = app.listen(0);
afterAll(() => server.close());

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tenants/${TENANT}/credentials/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  results.length = 0;
  vi.clearAllMocks();
});

describe("membership credential", () => {
  it("refuses a subject who is not a member", async () => {
    results.push(caller, []);
    const r = await post("membership", { subjectDid: "did:plc:stranger" });
    expect(r.status).toBe(404);
    expect(issueMembershipCredential).not.toHaveBeenCalled();
  });

  it("issues for a member and returns the jwt at the top level", async () => {
    results.push(caller, subjectWith([]), [{ name: "T", slug: "t" }]);
    const r = await post("membership", { subjectDid: "did:plc:member" });
    expect(r.status).toBe(200);
    expect(r.json.jwt).toBe("signed.jwt");
  });
});

describe("role attestation", () => {
  it("defaults to the subject's real role permissions", async () => {
    results.push(caller, subjectWith(["invite"]));
    const r = await post("role", { subjectDid: "did:plc:member" });
    expect(r.status).toBe(200);
    expect(issueRoleAttestation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ permissions: ["invite"] }),
      "did:plc:member",
    );
  });

  it("refuses permissions the subject's role does not grant", async () => {
    results.push(caller, subjectWith(["invite"]));
    const r = await post("role", { userDid: "did:plc:member", permissions: ["invite", "kick"] });
    expect(r.status).toBe(400);
    expect(r.json.permissions).toEqual(["kick"]);
    expect(issueRoleAttestation).not.toHaveBeenCalled();
  });

  it("refuses permissions the caller does not hold", async () => {
    results.push(caller, subjectWith(["invite", "manage_acl"]));
    const r = await post("role", { subjectDid: "did:plc:member", permissions: "invite, manage_acl" });
    expect(r.status).toBe(403);
    expect(r.json.permissions).toEqual(["manage_acl"]);
  });

  it("refuses a non-member subject", async () => {
    results.push(caller, []);
    const r = await post("role", { subjectDid: "did:plc:stranger", permissions: ["invite"] });
    expect(r.status).toBe(404);
  });
});

describe("capability token", () => {
  it("delegates a permission both the caller and subject hold", async () => {
    results.push(caller, subjectWith(["create_posts"]));
    const r = await post("capability", { subjectDid: "did:plc:member", capability: "create_posts" });
    expect(r.status).toBe(200);
    expect(issueCapabilityToken).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: ["create_posts"] }),
      "did:plc:member",
    );
  });

  it("refuses unknown capability names", async () => {
    results.push(caller);
    const r = await post("capability", { subjectDid: "did:plc:member", scope: ["root"] });
    expect(r.status).toBe(400);
  });

  it("refuses a capability the caller does not hold", async () => {
    results.push(caller, subjectWith(["kick"]));
    const r = await post("capability", { subjectDid: "did:plc:member", capability: "kick" });
    expect(r.status).toBe(403);
    expect(issueCapabilityToken).not.toHaveBeenCalled();
  });

  it("refuses a capability the subject does not hold", async () => {
    results.push(caller, subjectWith([]));
    const r = await post("capability", { subjectDid: "did:plc:member", capability: "invite" });
    expect(r.status).toBe(400);
  });
});

describe("credential bundle", () => {
  const member = [{ ...caller[0], membership: { ...caller[0].membership, createdAt: new Date() } }];

  it("attests the caller's role permissions", async () => {
    results.push(member, [{ name: "T" }]);
    expect((await post("bundle", {})).status).toBe(200);
    expect(issueRoleAttestation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ permissions: callerRole.permissions }),
      "did:plc:caller",
    );
  });

  it("an agent token attests only what its scope allows", async () => {
    results.push(member, [{ did: "did:plc:caller" }], [{ name: "T" }]);
    expect((await post("bundle", {}, { "x-agent-scope": "invite,kick" })).status).toBe(200);
    expect(issueRoleAttestation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ permissions: ["invite"] }),
      "did:plc:caller",
    );
  });
});
