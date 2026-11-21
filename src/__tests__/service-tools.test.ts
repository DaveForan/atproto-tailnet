/** MCP service tools (ADR-0030) and the parent's view of child boards: request shapes and the visibility rule. */
import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, pool: {} }));
vi.mock("../access/sync.js", () => ({ syncTenantAccess: vi.fn() }));
vi.mock("../access/devices.js", () => ({ listUserDevices: vi.fn(), listTenantDevices: vi.fn() }));
vi.mock("../notifications/service.js", () => ({ notify: vi.fn(), notifyUser: vi.fn() }));
vi.mock("../orchestrator/control-client.js", () => ({ useCoordinator: true, getControlClient: vi.fn() }));

import { TOOL_DEFS } from "../mcp/tools.js";
import type { ApiClient } from "../mcp/api-client.js";
import { childBoardVisible } from "../routes/boards.js";

const T = "11111111-1111-4111-8111-111111111111";
const POST = "99999999-9999-4999-8999-999999999999";
const ROLE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function run(name: string, args: Record<string, unknown>) {
  const calls: Array<[string, string, unknown]> = [];
  const api = { call: async (method: string, path: string, body?: unknown) => (calls.push([method, path, body]), { ok: true }) } as unknown as ApiClient;
  const tool = TOOL_DEFS.find((d) => d.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return Promise.resolve()
    .then(() => tool.run(api, args))
    .then(() => calls);
}

describe("MCP service tools", () => {
  it("publish_service posts to the board with the route's field names; private by default", async () => {
    expect(await run("publish_service", { tailnet_id: T, device_id: "12", port: 3000, title: "Food app", name: "food-app", web: true })).toEqual([
      ["POST", `/api/tenants/${T}/boards/posts`, { board: "private", title: "Food app", nodeId: "12", port: 3000, name: "food-app", web: true }],
    ]);
    const [[, , body]] = await run("publish_service", { tailnet_id: T, device_id: "12", port: 53, title: "DNS", board: "public", proto: "udp", role_ids: [ROLE] });
    expect(body).toEqual({ board: "public", title: "DNS", nodeId: "12", port: 53, proto: "udp", roleIds: [ROLE] });
  });

  it("refuses ids that could change the request path", async () => {
    await expect(run("publish_service", { tailnet_id: T, device_id: "../x", port: 1, title: "t" })).rejects.toThrow(/device_id/);
    await expect(run("remove_service", { tailnet_id: T, service_id: "1/../2" })).rejects.toThrow(/service_id/);
    await expect(run("connect_to_service", { tailnet_id: T, service_id: POST, device_ids: ["1", "2/3"] })).rejects.toThrow(/device_ids/);
  });

  it("connect_to_service, remove_service and list_services call the board routes", async () => {
    expect(await run("connect_to_service", { tailnet_id: T, service_id: POST, device_ids: ["20", "21"] })).toEqual([
      ["PUT", `/api/tenants/${T}/boards/posts/${POST}/connections`, { nodeIds: ["20", "21"] }],
    ]);
    expect(await run("remove_service", { tailnet_id: T, service_id: POST })).toEqual([["DELETE", `/api/tenants/${T}/boards/posts/${POST}`, undefined]]);
    expect((await run("list_services", { tailnet_id: T })).map((c) => c[1])).toEqual([
      `/api/tenants/${T}/boards/public`,
      `/api/tenants/${T}/boards/mine`,
      `/api/tenants/${T}/boards/children`,
    ]);
  });
});

describe("childBoardVisible", () => {
  const child = { status: "running", suspended: false, boardEnabled: true, federationPosture: "open" };
  it("only an open, running child with its board on shows its services to the parent", () => {
    expect(childBoardVisible(child)).toBe(true);
    expect(childBoardVisible({ ...child, federationPosture: "closed" })).toBe(false);
    // Selective posture is not implemented: it is closed
    expect(childBoardVisible({ ...child, federationPosture: "selective" })).toBe(false);
    expect(childBoardVisible({ ...child, suspended: true })).toBe(false);
    expect(childBoardVisible({ ...child, status: "deleted" })).toBe(false);
    expect(childBoardVisible({ ...child, boardEnabled: false })).toBe(false);
  });
});
