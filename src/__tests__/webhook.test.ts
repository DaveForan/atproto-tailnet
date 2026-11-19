import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  signWebhookBody,
  buildWebhookHeaders,
  validateWebhookUrl,
  deliverWebhook,
  nodeTransport,
  SIGNATURE_HEADER,
  EVENT_HEADER,
  type WebhookPayload,
} from "../notifications/webhook.js";

const payload: WebhookPayload = {
  type: "join_request",
  tenantId: "t1",
  tenantSlug: "acme",
  title: "New join request",
  body: "hello",
  link: "/#security",
  createdAt: "2026-11-19T00:00:00.000Z",
};

describe("webhook signing", () => {
  it("signs the raw body with HMAC-SHA256", () => {
    const body = JSON.stringify(payload);
    const expected = createHmac("sha256", "s3cret").update(body).digest("hex");
    expect(signWebhookBody(body, "s3cret")).toBe(`sha256=${expected}`);
  });

  it("adds the signature header only when a secret is set", () => {
    const body = "{}";
    expect(buildWebhookHeaders(body, "join_request", "k")[SIGNATURE_HEADER]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(buildWebhookHeaders(body, "join_request", null)[SIGNATURE_HEADER]).toBeUndefined();
    expect(buildWebhookHeaders(body, "join_request", null)[EVENT_HEADER]).toBe("join_request");
  });

  it("delivers the exact signed body", async () => {
    const transport = vi.fn(async () => ({ status: 204 }));
    const r = await deliverWebhook("https://hooks.example.com/x", "s3cret", payload, {
      allowPrivate: false,
      transport,
      resolvesPublic: async () => true,
    });
    expect(r).toEqual({ ok: true, status: 204 });
    const [, headers, body] = transport.mock.calls[0] as unknown as [URL, Record<string, string>, string];
    expect(JSON.parse(body)).toEqual(payload);
    expect(headers[SIGNATURE_HEADER]).toBe(signWebhookBody(body, "s3cret"));
  });

  it("reports redirects as failures (never followed)", async () => {
    const r = await deliverWebhook("https://hooks.example.com/x", null, payload, {
      allowPrivate: false,
      transport: async () => ({ status: 302 }),
      resolvesPublic: async () => true,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(302);
  });
});

describe("webhook URL validation", () => {
  it("rejects private, loopback and link-local literal targets", async () => {
    for (const url of [
      "https://127.0.0.1/hook",
      "https://10.0.0.5/hook",
      "https://192.168.1.10/hook",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/hook",
      "https://[::ffff:127.0.0.1]/hook",
    ]) {
      expect(await validateWebhookUrl(url, { allowPrivate: false })).toMatch(/public/);
    }
  });

  it("rejects hosts that resolve to private addresses", async () => {
    const err = await validateWebhookUrl("https://internal.example.com/hook", {
      allowPrivate: false,
      resolvesPublic: async () => false,
    });
    expect(err).toMatch(/public/);
  });

  it("requires https unless private targets are allowed", async () => {
    expect(await validateWebhookUrl("http://hooks.example.com/x", { allowPrivate: false })).toMatch(/https/);
    expect(await validateWebhookUrl("ftp://hooks.example.com/x", { allowPrivate: true })).toMatch(/http/);
    expect(await validateWebhookUrl("http://10.0.0.5:8080/x", { allowPrivate: true })).toBeNull();
  });

  it("rejects credentials and garbage", async () => {
    expect(await validateWebhookUrl("https://u:p@hooks.example.com/x", { allowPrivate: false })).toMatch(/credentials/);
    expect(await validateWebhookUrl("not a url", { allowPrivate: false })).toMatch(/valid/);
  });

  it("accepts public https targets", async () => {
    expect(
      await validateWebhookUrl("https://ntfy.example.org/topic", {
        allowPrivate: false,
        resolvesPublic: async () => true,
      }),
    ).toBeNull();
  });

  it("does not send to a private address even when called directly", async () => {
    const transport = vi.fn(async () => ({ status: 200 }));
    const r = await deliverWebhook("https://127.0.0.1/x", null, payload, { allowPrivate: false, transport });
    expect(r.ok).toBe(false);
    expect(transport).not.toHaveBeenCalled();
  });

  it("the default transport refuses private IP literals at connect time", async () => {
    await expect(
      nodeTransport(new URL("https://127.0.0.1:1/x"), {}, "{}", { allowPrivate: false, timeoutMs: 1000 }),
    ).rejects.toThrow(/non-public/);
  });
});
