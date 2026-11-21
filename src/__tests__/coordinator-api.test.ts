/** CoordinatorApiClient: typed errors, tenant scoping and health timeouts. */
import { describe, it, expect, vi, afterEach } from "vitest";
import { CoordinatorApiClient, CoordinatorError, isCoordinatorStatus } from "../orchestrator/coordinator-api.js";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
afterEach(() => fetchMock.mockReset());

const reply = (status: number, body: unknown = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status });

describe("CoordinatorApiClient", () => {
  const scoped = new CoordinatorApiClient("http://coord/", "t-1", "key");
  const instance = new CoordinatorApiClient("http://coord", "", "key");

  it("throws CoordinatorError with the HTTP status", async () => {
    fetchMock.mockResolvedValueOnce(reply(500, { error: "boom" }));
    const err = await scoped.setPosture("open").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoordinatorError);
    expect((err as CoordinatorError).status).toBe(500);
    expect(isCoordinatorStatus(err, 500)).toBe(true);
    expect(isCoordinatorStatus(new Error("failed (500)"), 500)).toBe(false);
  });

  it("maps statuses, not error text", async () => {
    fetchMock.mockResolvedValueOnce(reply(404));
    expect(await scoped.allowOneMachine("u-1", 600)).toBeNull();
    fetchMock.mockResolvedValueOnce(reply(409));
    expect(await scoped.allowOneMachine("u-1", 600)).toBe("full");
    fetchMock.mockResolvedValueOnce(reply(404));
    expect(await scoped.tenantExists()).toBe(false);
    fetchMock.mockResolvedValueOnce(reply(404));
    await expect(scoped.revokePreAuthKey("k")).resolves.toBeUndefined();
  });

  it("refuses tenant-scoped calls on an instance-level client before any request", async () => {
    await expect(instance.listNodes()).rejects.toThrow(/instance-level client/);
    await expect(instance.createPreAuthKey("x")).rejects.toThrow(/instance-level client/);
    await expect(instance.deleteNode("1")).rejects.toThrow(/instance-level client/);
    await expect(instance.setAutoApprovers({ routes: {}, exit_node: [] })).rejects.toThrow(/instance-level client/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("setParent sends PUT /api/tenants/{id}/parent with parent_id (null = top level)", async () => {
    fetchMock.mockResolvedValueOnce(reply(204));
    await scoped.setParent(null);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://coord/api/tenants/t-1/parent");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ parent_id: null });
    await expect(instance.setParent(null)).rejects.toThrow(/instance-level client/);
  });

  it("allows instance-level calls without a tenant", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { id: "c-1" }));
    expect(await instance.createTenant("t-slug")).toEqual({ id: "c-1" });
    expect(fetchMock.mock.calls[0][0]).toBe("http://coord/api/tenants");
  });

  it("only pushes auto-approvers (the caller stores them)", async () => {
    fetchMock.mockResolvedValueOnce(reply(204));
    await scoped.setAutoApprovers({ routes: { "10.0.0.0/24": ["tag:x"] } } as never);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://coord/api/tenants/t-1/auto-approvers");
    expect(JSON.parse(init.body)).toEqual({ routes: { "10.0.0.0/24": ["tag:x"] }, exit_node: [] });
  });

  it("bounds the healthcheck with a timeout", async () => {
    fetchMock.mockResolvedValueOnce(reply(200));
    expect(await scoped.healthcheck()).toBe(true);
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    fetchMock.mockRejectedValueOnce(new DOMException("timeout", "TimeoutError"));
    expect(await scoped.healthcheck()).toBe(false);
  });
});
