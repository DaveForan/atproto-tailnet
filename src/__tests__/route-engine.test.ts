import { describe, it, expect } from "vitest";
import { RouteTable } from "../federation/route-engine.js";
import type { RouteUpdate, RouteAnnouncement } from "../federation/protocol.js";

const LOCAL_DID = "did:web:local.example.com";
const REMOTE_DID = "did:web:remote.example.com";
const THIRD_DID = "did:web:third.example.com";

function makeAnnouncement(overrides: Partial<RouteAnnouncement> = {}): RouteAnnouncement {
  return {
    prefix: "10.1.0.0/24",
    originDid: REMOTE_DID,
    pathVector: [REMOTE_DID],
    preference: 100,
    originSignature: "sig",
    ...overrides,
  };
}

function makeUpdate(overrides: Partial<RouteUpdate> = {}): RouteUpdate {
  return {
    type: "ROUTE_UPDATE",
    sessionId: "session-1",
    announcements: [makeAnnouncement()],
    withdrawals: [],
    signature: "sig",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("RouteTable", () => {
  it("installs announced routes", () => {
    const table = new RouteTable(LOCAL_DID);
    const result = table.processUpdate(makeUpdate(), ["10.0.0.0/8"]);
    expect(result.installed).toEqual(["10.1.0.0/24"]);
    expect(result.rejected).toEqual([]);
    expect(table.size()).toBe(1);
  });

  it("rejects routes with local DID in path vector (loop prevention)", () => {
    const table = new RouteTable(LOCAL_DID);
    const result = table.processUpdate(
      makeUpdate({
        announcements: [makeAnnouncement({ pathVector: [REMOTE_DID, LOCAL_DID] })],
      }),
      ["10.0.0.0/8"],
    );
    expect(result.rejected).toEqual(["10.1.0.0/24"]);
    expect(result.installed).toEqual([]);
    expect(table.size()).toBe(0);
  });

  it("rejects routes outside agreed CIDR scope", () => {
    const table = new RouteTable(LOCAL_DID);
    const result = table.processUpdate(makeUpdate(), ["192.168.0.0/16"]);
    expect(result.rejected).toEqual(["10.1.0.0/24"]);
    expect(table.size()).toBe(0);
  });

  it("withdraws routes", () => {
    const table = new RouteTable(LOCAL_DID);
    table.processUpdate(makeUpdate(), ["10.0.0.0/8"]);
    expect(table.size()).toBe(1);

    const result = table.processUpdate(
      makeUpdate({ announcements: [], withdrawals: ["10.1.0.0/24"] }),
      ["10.0.0.0/8"],
    );
    expect(result.withdrawn).toEqual(["10.1.0.0/24"]);
    expect(table.size()).toBe(0);
  });

  it("prefers higher preference routes", () => {
    const table = new RouteTable(LOCAL_DID);
    table.processUpdate(
      makeUpdate({ announcements: [makeAnnouncement({ preference: 50 })] }),
      ["10.0.0.0/8"],
    );
    expect(table.getRoute("10.1.0.0/24")?.preference).toBe(50);

    table.processUpdate(
      makeUpdate({ announcements: [makeAnnouncement({ preference: 200 })] }),
      ["10.0.0.0/8"],
    );
    expect(table.getRoute("10.1.0.0/24")?.preference).toBe(200);
  });

  it("does not downgrade preference", () => {
    const table = new RouteTable(LOCAL_DID);
    table.processUpdate(
      makeUpdate({ announcements: [makeAnnouncement({ preference: 200 })] }),
      ["10.0.0.0/8"],
    );
    table.processUpdate(
      makeUpdate({ announcements: [makeAnnouncement({ preference: 50 })] }),
      ["10.0.0.0/8"],
    );
    expect(table.getRoute("10.1.0.0/24")?.preference).toBe(200);
  });

  it("exports routes excluding the session they came from", () => {
    const table = new RouteTable(LOCAL_DID);
    table.processUpdate(
      makeUpdate({ sessionId: "session-1" }),
      ["10.0.0.0/8"],
    );
    table.processUpdate(
      makeUpdate({
        sessionId: "session-2",
        announcements: [makeAnnouncement({ prefix: "10.2.0.0/24" })],
      }),
      ["10.0.0.0/8"],
    );

    const exported = table.getExportableRoutes("session-1", ["10.0.0.0/8"]);
    expect(exported.map((r) => r.prefix)).toEqual(["10.2.0.0/24"]);
    expect(exported[0].pathVector).toContain(LOCAL_DID);
  });

  it("withdraws all routes from a torn-down session", () => {
    const table = new RouteTable(LOCAL_DID);
    table.processUpdate(
      makeUpdate({
        sessionId: "session-1",
        announcements: [
          makeAnnouncement({ prefix: "10.1.0.0/24" }),
          makeAnnouncement({ prefix: "10.2.0.0/24" }),
        ],
      }),
      ["10.0.0.0/8"],
    );
    table.processUpdate(
      makeUpdate({
        sessionId: "session-2",
        announcements: [makeAnnouncement({ prefix: "10.3.0.0/24" })],
      }),
      ["10.0.0.0/8"],
    );

    expect(table.size()).toBe(3);
    const withdrawn = table.withdrawSessionRoutes("session-1");
    expect(withdrawn.sort()).toEqual(["10.1.0.0/24", "10.2.0.0/24"]);
    expect(table.size()).toBe(1);
  });

  it("allows all routes when CIDR scope is empty (unrestricted)", () => {
    const table = new RouteTable(LOCAL_DID);
    const result = table.processUpdate(makeUpdate(), []);
    expect(result.installed).toEqual(["10.1.0.0/24"]);
  });
});
