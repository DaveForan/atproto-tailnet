/**
 * @module federation/transport
 * Outbound CFP messages between federation brokers over HTTPS (ADR-0016, ADR-0019).
 */

import { logger } from "../logger.js";
import { isOwnOrigin } from "./discovery.js";
import { guardedRequest, outboundErrorText } from "../identity/resolver.js";
import type { CFPMessage, KeepaliveMessage, RevokeMessage } from "./protocol.js";

export type { CFPMessage };

const SEND_TIMEOUT_MS = 10_000;

/**
 * Header naming the collective DID a message is addressed to. One instance
 * hosts many collectives behind the same broker URL, so the receiver needs it
 * to pick the tenant (and key) that should answer.
 */
export const RECIPIENT_HEADER = "CFP-Recipient";

/** Endpoint path segment of a message type: `LINK_REQUEST` → `link-request`. */
export function messageEndpoint(type: CFPMessage["type"]): string {
  return type.toLowerCase().replace(/_/g, "-");
}

export interface SendResult {
  ok: boolean;
  /** HTTP status when the peer answered; absent on network errors/timeouts. */
  status?: number;
  response?: CFPMessage;
  error?: string;
}

/** Largest peer answer we read (a CFP message is small). */
const MAX_RESPONSE_BYTES = 256 * 1024;


export async function sendMessage(
  remoteEndpoint: string,
  message: CFPMessage,
  recipientDid: string,
): Promise<SendResult> {
  const url = `${remoteEndpoint.replace(/\/+$/, "")}/api/federation/messages/${messageEndpoint(message.type)}`;
  const headers = {
    "Content-Type": "application/json",
    [RECIPIENT_HEADER]: recipientDid,
  };
  const body = JSON.stringify(message);

  try {
    let status: number;
    let text: string;
    // Only this instance's exact origin may skip the guard (dev serves it over http).
    if (isOwnOrigin(url) && !/[?#]/.test(remoteEndpoint)) {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        redirect: "error",
      });
      status = res.status;
      text = res.ok ? await res.text() : "";
    } else {
      // Peer-controlled URL: public addresses checked at connect time, no redirects (ADR-0019 §5), size cap.
      const res = await guardedRequest(url, {
        method: "POST",
        headers,
        body,
        timeoutMs: SEND_TIMEOUT_MS,
        maxBytes: MAX_RESPONSE_BYTES,
      });
      status = res.status;
      text = res.text;
    }

    if (status < 200 || status >= 300) {
      // The remote body is never read into logs or errors: only the status
      logger.warn({ url, status }, "federation message send failed");
      return { ok: false, status, error: `HTTP ${status}` };
    }

    let response: CFPMessage | undefined;
    try {
      response = text ? (JSON.parse(text) as CFPMessage) : undefined;
    } catch {
      response = undefined;
    }
    return { ok: true, status, response };
  } catch (err) {
    logger.warn({ url, err }, "federation message send error");
    return { ok: false, error: outboundErrorText(err) };
  }
}

export async function sendKeepalive(
  remoteEndpoint: string,
  keepalive: KeepaliveMessage,
  recipientDid: string,
): Promise<boolean> {
  const result = await sendMessage(remoteEndpoint, keepalive, recipientDid);
  return result.ok;
}

export async function sendRevoke(
  remoteEndpoint: string,
  revoke: RevokeMessage,
  recipientDid: string,
): Promise<boolean> {
  const result = await sendMessage(remoteEndpoint, revoke, recipientDid);
  return result.ok;
}
