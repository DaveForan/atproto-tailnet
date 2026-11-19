/**
 * @module federation/transport
 * HTTP transport for inter-instance CFP messages (ADR-0016, ADR-0019).
 * Sends handshake, keepalive, revoke and link-negotiation messages between
 * federation broker instances over HTTPS.
 */

import { logger } from "../logger.js";
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

export async function sendMessage(
  remoteEndpoint: string,
  message: CFPMessage,
  recipientDid: string,
): Promise<SendResult> {
  const url = `${remoteEndpoint.replace(/\/+$/, "")}/api/federation/messages/${messageEndpoint(message.type)}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [RECIPIENT_HEADER]: recipientDid,
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      // A peer-controlled URL must not bounce us somewhere else (ADR-0019 §5).
      redirect: "error",
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        { url, status: res.status, body },
        "federation message send failed",
      );
      return { ok: false, status: res.status, error: `HTTP ${res.status}: ${body.slice(0, 500)}` };
    }

    const response = (await res.json().catch(() => undefined)) as CFPMessage | undefined;
    return { ok: true, status: res.status, response };
  } catch (err) {
    const message_str = err instanceof Error ? err.message : "Unknown error";
    logger.warn({ url, err }, "federation message send error");
    return { ok: false, error: message_str };
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
