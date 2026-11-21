/**
 * Outbound webhooks: https to public addresses only, checked again at connect time.
 * No redirects. 5 s timeout. `WEBHOOK_ALLOW_PRIVATE=true` removes the address and https rules.
 */

import { createHmac } from "node:crypto";
import type dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { guardedLookup, isPublicAddress, resolvesToPublicAddresses } from "../identity/resolver.js";

/** Delivery timeout for connect plus response headers. */
export const WEBHOOK_TIMEOUT_MS = 5_000;
export const WEBHOOK_MAX_URL_LENGTH = 2048;
export const EVENT_HEADER = "X-Atproto-Tailnet-Event";
export const SIGNATURE_HEADER = "X-Atproto-Tailnet-Signature";
/** Delivery time in Unix seconds. It is signed so that receivers can refuse replays. */
export const TIMESTAMP_HEADER = "X-Atproto-Tailnet-Timestamp";

export interface WebhookPayload {
  type: string;
  tenantId: string;
  tenantSlug: string;
  title: string;
  body: string;
  link: string | null;
  createdAt: string;
}

export interface WebhookResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** Syntax and scheme checks only, with no DNS. Returns an error message or null. */
export function checkWebhookUrlSyntax(
  raw: string,
  allowPrivate: boolean,
): { url: URL } | { error: string } {
  if (raw.length > WEBHOOK_MAX_URL_LENGTH) return { error: "Webhook URL is too long" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: "Webhook URL is not a valid URL" };
  }
  const allowedProtocols = allowPrivate ? ["https:", "http:"] : ["https:"];
  if (!allowedProtocols.includes(url.protocol)) {
    return { error: allowPrivate ? "Webhook URL must use http or https" : "Webhook URL must use https" };
  }
  if (url.username || url.password) return { error: "Webhook URL must not contain credentials" };
  if (!url.hostname) return { error: "Webhook URL has no host" };
  return { url };
}

/**
 * Checks syntax, scheme, and that the host resolves only to public addresses (unless private is allowed).
 * Returns null when valid, else a user-facing error message.
 */
export async function validateWebhookUrl(
  raw: string,
  opts: { allowPrivate: boolean; resolvesPublic?: (host: string) => Promise<boolean> },
): Promise<string | null> {
  const syntax = checkWebhookUrlSyntax(raw, opts.allowPrivate);
  if ("error" in syntax) return syntax.error;
  if (opts.allowPrivate) return null;
  const check = opts.resolvesPublic ?? resolvesToPublicAddresses;
  if (!(await check(syntax.url.hostname))) {
    return "Webhook host must resolve to public addresses only";
  }
  return null;
}

/** `sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">` */
export function signWebhookBody(rawBody: string, secret: string, timestamp: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

/** The signature header is present only when a secret is set. */
export function buildWebhookHeaders(
  rawBody: string,
  type: string,
  secret: string | null | undefined,
  timestamp: string = String(Math.floor(Date.now() / 1000)),
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "atproto-tailnet-webhook/1",
    [EVENT_HEADER]: type,
    [TIMESTAMP_HEADER]: timestamp,
  };
  if (secret) headers[SIGNATURE_HEADER] = signWebhookBody(rawBody, secret, timestamp);
  return headers;
}

/** Sends one POST. Injectable for tests. It must not follow redirects. */
export type WebhookTransport = (
  url: URL,
  headers: Record<string, string>,
  body: string,
  opts: { allowPrivate: boolean; timeoutMs: number },
) => Promise<{ status: number }>;

/** Default transport: node:http(s) with guarded DNS and no redirects. */
export const nodeTransport: WebhookTransport = (url, headers, body, opts) =>
  new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!opts.allowPrivate && net.isIP(host) && !isPublicAddress(host)) {
      reject(new Error("Webhook host is a non-public address"));
      return;
    }
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body).toString() },
        lookup: opts.allowPrivate ? undefined : (guardedLookup as unknown as typeof dns.lookup),
        signal: AbortSignal.timeout(opts.timeoutMs),
        timeout: opts.timeoutMs,
      },
      (res) => {
        res.resume(); // Discards the body. A 3xx is reported, never followed.
        resolve({ status: res.statusCode ?? 0 });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Webhook timed out")));
    req.on("error", reject);
    req.end(body);
  });

/**
 * Delivers one webhook. It never throws; the result reports failures.
 * It validates the URL again, because DNS can change after the URL is stored.
 */
export async function deliverWebhook(
  rawUrl: string,
  secret: string | null | undefined,
  payload: WebhookPayload,
  opts: {
    allowPrivate: boolean;
    transport?: WebhookTransport;
    resolvesPublic?: (host: string) => Promise<boolean>;
  },
): Promise<WebhookResult> {
  try {
    const invalid = await validateWebhookUrl(rawUrl, opts);
    if (invalid) return { ok: false, error: invalid };
    const body = JSON.stringify(payload);
    const headers = buildWebhookHeaders(body, payload.type, secret);
    const { status } = await (opts.transport ?? nodeTransport)(new URL(rawUrl), headers, body, {
      allowPrivate: opts.allowPrivate,
      timeoutMs: WEBHOOK_TIMEOUT_MS,
    });
    const ok = status >= 200 && status < 300;
    return ok ? { ok, status } : { ok, status, error: `Webhook responded with HTTP ${status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Webhook delivery failed" };
  }
}
