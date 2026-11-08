import * as jose from "jose";
import { eq, lt } from "drizzle-orm";
import { verifySignature } from "@atproto/crypto";
import { db } from "../db/index.js";
import { serviceAuthJtiCache } from "../db/schema.js";
import { getResolver } from "../identity/resolver.js";
import { logger } from "../logger.js";

const PRESENTATION_LXM = "app.tailnet.credential.present";
const MAX_EXP_SECONDS = 120;
const MAX_TOKEN_LENGTH = 4096;

export interface ServiceAuthResult {
  valid: boolean;
  issuerDid?: string;
  error?: string;
}

export async function verifyServiceAuth(
  token: string,
  audienceDid: string,
): Promise<ServiceAuthResult> {
  if (token.length > MAX_TOKEN_LENGTH) {
    return { valid: false, error: "Token too large" };
  }

  let header: jose.ProtectedHeaderParameters;
  let payload: jose.JWTPayload;
  try {
    header = jose.decodeProtectedHeader(token);
    payload = jose.decodeJwt(token);
  } catch {
    return { valid: false, error: "Malformed JWT" };
  }

  const alg = header.alg;
  if (alg !== "ES256K" && alg !== "ES256") {
    return { valid: false, error: `Unsupported algorithm: ${alg}` };
  }

  const iss = payload.iss;
  if (!iss || typeof iss !== "string") {
    return { valid: false, error: "Missing issuer" };
  }

  const aud = payload.aud;
  const audStr = Array.isArray(aud) ? aud[0] : aud;
  const expectedAud = `${audienceDid}#tailnet_collective`;
  if (audStr !== expectedAud) {
    return { valid: false, error: `Audience mismatch: expected ${expectedAud}` };
  }

  const lxm = (payload as Record<string, unknown>).lxm;
  if (lxm !== PRESENTATION_LXM) {
    return { valid: false, error: `Invalid lxm: expected ${PRESENTATION_LXM}` };
  }

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp <= now) {
    return { valid: false, error: "Token expired" };
  }
  if (payload.exp > now + MAX_EXP_SECONDS) {
    return { valid: false, error: "Token expiry too far in the future" };
  }
  if (payload.iat && payload.iat > now + 30) {
    return { valid: false, error: "Token issued in the future" };
  }

  const jti = payload.jti;
  if (!jti || typeof jti !== "string") {
    return { valid: false, error: "Missing jti" };
  }

  const resolver = getResolver();
  const resolved = await resolver.resolveTyped(iss, {
    methodId: "#atproto",
    algorithms: [alg],
  });
  if (!resolved || !resolved.didKey) {
    return { valid: false, error: `Cannot resolve #atproto key for ${iss}` };
  }

  try {
    const [headerB64, payloadB64, sigB64] = token.split(".");
    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const sigBytes = jose.base64url.decode(sigB64);

    const valid = await verifySignature(
      resolved.didKey,
      signingInput,
      sigBytes,
    );
    if (!valid) {
      return { valid: false, error: "Signature verification failed" };
    }
  } catch (err) {
    logger.debug({ err, iss }, "service-auth signature verification error");
    return { valid: false, error: "Signature verification failed" };
  }

  const replayed = await checkAndRecordJti(jti, iss, expectedAud, payload.exp);
  if (replayed) {
    return { valid: false, error: "Token already used (jti replay)" };
  }

  return { valid: true, issuerDid: iss };
}

async function checkAndRecordJti(
  jti: string,
  issuerDid: string,
  audienceDid: string,
  exp: number,
): Promise<boolean> {
  try {
    await db.insert(serviceAuthJtiCache).values({
      jti,
      issuerDid,
      audienceDid,
      expiresAt: new Date(exp * 1000),
    });
    return false;
  } catch (err: unknown) {
    const pgErr = err as { code?: string; cause?: { code?: string } };
    if (pgErr.code === "23505" || pgErr.cause?.code === "23505") {
      return true;
    }
    throw err;
  }
}

export async function sweepExpiredJtis(): Promise<number> {
  const result = await db
    .delete(serviceAuthJtiCache)
    .where(lt(serviceAuthJtiCache.expiresAt, new Date()))
    .returning({ jti: serviceAuthJtiCache.jti });
  return result.length;
}
