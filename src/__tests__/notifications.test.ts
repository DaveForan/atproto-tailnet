import { describe, it, expect, vi, beforeEach } from "vitest";

/** Chainable, awaitable query mock: each awaited select() yields the next queued result. */
const selectQueue: unknown[][] = [];
const inserted: unknown[] = [];
function chain(result: () => unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ["from", "where", "leftJoin", "innerJoin", "orderBy", "limit"]) {
    c[m] = () => c;
  }
  c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(result()).then(res, rej);
  return c;
}

vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn(() => chain(() => selectQueue.shift() ?? [])),
    insert: vi.fn(() => ({
      values: vi.fn(async (rows: unknown) => {
        inserted.push(rows);
      }),
    })),
  },
}));

vi.mock("../config.js", () => ({ config: { webhookAllowPrivate: false } }));

const deliverMock = vi.fn(async () => ({ ok: true, status: 200 }));
vi.mock("../notifications/webhook.js", () => ({
  deliverWebhook: (...args: unknown[]) => deliverMock(...(args as [])),
}));

import {
  selectRecipients,
  createNotification,
  NOTIFICATION_PERMISSION,
} from "../notifications/service.js";

const members = [
  { userId: "orig", isOriginator: true, permissions: [] },
  { userId: "approver", isOriginator: false, permissions: ["approve_devices"] },
  { userId: "joiner", isOriginator: false, permissions: ["approve_joins"] },
  { userId: "svc", isOriginator: false, permissions: ["approve_services", "manage_services"] },
  { userId: "plain", isOriginator: false, permissions: ["invite"] },
  { userId: "norole", isOriginator: false, permissions: null },
];

describe("selectRecipients", () => {
  it("device approvals go to the originator and approve_devices holders", () => {
    expect(selectRecipients(members, "device_approval_requested").sort()).toEqual(["approver", "orig"]);
  });

  it("join requests go to approve_joins holders", () => {
    expect(selectRecipients(members, "join_request").sort()).toEqual(["joiner", "orig"]);
  });

  it("service and service-device approvals go to approve_services holders", () => {
    expect(selectRecipients(members, "service_approval_requested").sort()).toEqual(["orig", "svc"]);
    expect(selectRecipients(members, "service_device_approval_requested").sort()).toEqual(["orig", "svc"]);
  });

  it("device limit notices go to device approvers", () => {
    expect(NOTIFICATION_PERMISSION.device_limit_reached).toBe("approve_devices");
    expect(selectRecipients(members, "device_limit_reached").sort()).toEqual(["approver", "orig"]);
  });

  it("never includes members without the permission, and dedupes", () => {
    const r = selectRecipients([...members, members[0]], "join_request");
    expect(r).not.toContain("plain");
    expect(r).not.toContain("norole");
    expect(r.filter((u) => u === "orig")).toHaveLength(1);
  });
});

describe("createNotification", () => {
  beforeEach(() => {
    selectQueue.length = 0;
    inserted.length = 0;
    deliverMock.mockClear();
  });

  it("stores one row per recipient and fires the webhook in the background", async () => {
    selectQueue.push(
      [{ id: "t1", slug: "acme", webhookUrl: "https://hooks.example.com/x", webhookSecret: "s3cret" }],
      members,
    );
    const n = await createNotification("t1", "join_request", { title: "New join request", body: "b" });
    expect(n).toBe(2);
    const rows = inserted[0] as Array<{ userId: string; type: string; tenantId: string }>;
    expect(rows.map((r) => r.userId).sort()).toEqual(["joiner", "orig"]);
    expect(rows.every((r) => r.type === "join_request" && r.tenantId === "t1")).toBe(true);

    // Delivery is deferred (setImmediate) — not on the request path
    expect(deliverMock).not.toHaveBeenCalled();
    await new Promise((r) => setImmediate(r));
    expect(deliverMock).toHaveBeenCalledTimes(1);
    const [url, secret, payload] = deliverMock.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(url).toBe("https://hooks.example.com/x");
    expect(secret).toBe("s3cret");
    expect(payload).toMatchObject({ type: "join_request", tenantId: "t1", tenantSlug: "acme", title: "New join request" });
  });

  it("does not fire a webhook when none is configured", async () => {
    selectQueue.push([{ id: "t1", slug: "acme", webhookUrl: null, webhookSecret: null }], members);
    await createNotification("t1", "device_approval_requested", { title: "x" });
    await new Promise((r) => setImmediate(r));
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it("skips duplicates inside the dedupe window", async () => {
    selectQueue.push([{ id: "t1", slug: "acme", webhookUrl: null, webhookSecret: null }], [{ id: "n-recent" }]);
    const n = await createNotification("t1", "device_limit_reached", { title: "x" }, { dedupeWindowMs: 3600_000 });
    expect(n).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it("never throws", async () => {
    selectQueue.push([{ id: "t1", slug: "acme", webhookUrl: null, webhookSecret: null }]);
    // members query resolves to a non-array → internal error is swallowed
    selectQueue.push(null as unknown as unknown[]);
    await expect(createNotification("t1", "join_request", { title: "x" })).resolves.toBe(0);
  });
});
