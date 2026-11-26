/** Route helpers of control-types: route ids, the routes of a node, and exit-route approval. */
import { describe, it, expect } from "vitest";
import {
  routeId,
  parseRouteId,
  routesOfNode,
  withRouteApproval,
  type ControlNode,
} from "../orchestrator/control-types.js";

describe("routes derived from nodes", () => {
  const node: ControlNode = {
    id: "5",
    name: "router",
    givenName: "router",
    online: true,
    hold: "none",
    availableRoutes: ["10.0.0.0/24", "0.0.0.0/0", "::/0"],
    approvedRoutes: ["10.0.0.0/24", "192.168.9.0/24"],
    subnetRoutes: ["10.0.0.0/24"],
  };

  it("round-trips route ids, including IPv6 prefixes", () => {
    for (const prefix of ["10.0.0.0/24", "::/0", "fd7a:115c:a1e0::/48"]) {
      const id = routeId("12", prefix);
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(parseRouteId(id)).toEqual({ nodeId: "12", prefix });
    }
    expect(parseRouteId("12")).toBeNull();
    expect(parseRouteId("x-MTAuMC4wLjAvMjQ")).toBeNull();
    expect(parseRouteId("12-!!")).toBeNull();
    expect(parseRouteId("../user/1")).toBeNull();
  });

  it("also reads the plain <nodeId>:<cidr> form", () => {
    expect(parseRouteId("12:10.0.0.0/24")).toEqual({ nodeId: "12", prefix: "10.0.0.0/24" });
    expect(parseRouteId("12:::/0")).toEqual({ nodeId: "12", prefix: "::/0" });
    expect(parseRouteId("x:10.0.0.0/24")).toBeNull();
  });

  it("lists advertised and still-approved routes with their state", () => {
    const routes = routesOfNode(node);
    const byPrefix = Object.fromEntries(routes.map((r) => [r.prefix, r]));
    expect(routes).toHaveLength(4);
    expect(byPrefix["10.0.0.0/24"]).toMatchObject({ advertised: true, enabled: true, isPrimary: true });
    expect(byPrefix["0.0.0.0/0"]).toMatchObject({ advertised: true, enabled: false });
    expect(byPrefix["192.168.9.0/24"]).toMatchObject({ advertised: false, enabled: true });
    expect(byPrefix["10.0.0.0/24"].node).toMatchObject({ id: "5", online: true });
  });

  it("returns no routes for a node without route fields", () => {
    expect(routesOfNode({ id: "1", name: "laptop", hold: "none" })).toEqual([]);
  });

  it("moves the two exit routes together", () => {
    expect(withRouteApproval(["10.0.0.0/24"], "::/0", true)).toEqual([
      "10.0.0.0/24",
      "0.0.0.0/0",
      "::/0",
    ]);
    expect(withRouteApproval(["0.0.0.0/0", "::/0", "10.0.0.0/24"], "0.0.0.0/0", false)).toEqual([
      "10.0.0.0/24",
    ]);
    expect(withRouteApproval(["10.0.0.0/24"], "10.0.0.0/24", true)).toEqual(["10.0.0.0/24"]);
  });
});
