/**
 * @module federation/transport
 * HTTP transport for inter-instance CFP messages (ADR-0016).
 * Sends and receives handshake, keepalive, and revoke messages
 * between federation broker instances over HTTPS.
 */

import { logger } from "../logger.js";
import type {
  HelloMessage,
  ChallengeMessage,
  CommitMessage,
  EstablishedMessage,
  KeepaliveMessage,
  RevokeMessage,
} from "./protocol.js";

export type CFPMessage =
  | HelloMessage
  | ChallengeMessage
  | CommitMessage
  | EstablishedMessage
  | KeepaliveMessage
  | RevokeMessage;

const SEND_TIMEOUT_MS = 10_000;

/**
 * Header naming the collective DID a message is addressed to. One instance
 * hosts many collectives behind the same broker URL, so the receiver needs it
 * to pick the tenant (and key) that should answer.
 */
export const RECIPIENT_HEADER = "CFP-Recipient";

export async function sendMessage(
  remoteEndpoint: string,
  message: CFPMessage,
  recipientDid: string,
): Promise<{ ok: boolean; response?: CFPMessage; error?: string }> {
  const messageType = message.type.toLowerCase();
  const url = `${remoteEndpoint.replace(/\/+$/, "")}/api/federation/messages/${messageType}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [RECIPIENT_HEADER]: recipientDid,
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        { url, status: res.status, body },
        "federation message send failed",
      );
      return { ok: false, error: `HTTP ${res.status}: ${body}` };
    }

    const response = (await res.json()) as CFPMessage;
    return { ok: true, response };
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
