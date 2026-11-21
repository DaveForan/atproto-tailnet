/** Verifies VC-JWT credentials and holder binding proofs (ADR-0012). */

import * as jose from "jose";
import type {
  CredentialType,
  CredentialVerificationResult,
  HolderBindingChallenge,
  HolderBindingProof,
} from "./types.js";

type VerifyKey = jose.CryptoKey | jose.KeyObject;

export interface ResolvedKey {
  key: VerifyKey;
  algorithm: string;
  methodId: string;
  didKey?: string;
}

export interface PublicKeyResolver {
  resolve(did: string): Promise<VerifyKey | null>;
  resolveTyped?(
    did: string,
    opts?: { methodId?: string; algorithms?: string[] },
  ): Promise<ResolvedKey | null>;
}

export async function verifyCredential(
  jwt: string,
  resolver: PublicKeyResolver,
): Promise<CredentialVerificationResult> {
  try {
    const protectedHeader = jose.decodeProtectedHeader(jwt);
    if (protectedHeader.alg !== "EdDSA") {
      return { valid: false, error: "Unsupported algorithm" };
    }

    const unverified = jose.decodeJwt(jwt);
    const issuerDid = unverified.iss;
    if (!issuerDid) {
      return { valid: false, error: "Missing issuer" };
    }

    const publicKey = await resolver.resolve(issuerDid);
    if (!publicKey) {
      return { valid: false, error: `Cannot resolve public key for ${issuerDid}` };
    }

    const { payload } = await jose.jwtVerify(jwt, publicKey, {
      algorithms: ["EdDSA"],
    });

    const vc = payload.vc as Record<string, unknown> | undefined;
    if (!vc || !Array.isArray(vc.type)) {
      return { valid: false, error: "Invalid VC structure" };
    }

    const credentialType = vc.type.find(
      (t: string) => t !== "VerifiableCredential",
    ) as CredentialType | undefined;

    return {
      valid: true,
      credentialType,
      subject: payload.sub,
      issuer: issuerDid,
      expiresAt: payload.exp ? new Date(payload.exp * 1000) : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Verification failed";
    return { valid: false, error: message };
  }
}

/** Format of nonces minted by `generateHolderChallenge` (32 bytes, base64url). */
const HOLDER_NONCE_RE = /^[A-Za-z0-9_-]{43}$/;

export async function verifyHolderBinding(
  proof: HolderBindingProof,
  challenge: HolderBindingChallenge,
  resolver: PublicKeyResolver,
): Promise<{ valid: boolean; error?: string }> {
  if (proof.nonce !== challenge.nonce) {
    return { valid: false, error: "Nonce mismatch" };
  }

  const now = new Date();
  if (now > new Date(challenge.expiresAt)) {
    return { valid: false, error: "Challenge expired" };
  }

  // Security: a binding proof is a detached EdDSA JWS over the bare nonce.
  // CFP messages use the same primitive. Only the exact challenge nonce format is accepted.
  // Then a signature over a CFP message or challenge response cannot pass as a proof.
  if (!HOLDER_NONCE_RE.test(proof.nonce)) {
    return { valid: false, error: "Malformed nonce" };
  }

  const publicKey = await resolver.resolve(proof.did);
  if (!publicKey) {
    return { valid: false, error: `Cannot resolve public key for ${proof.did}` };
  }

  try {
    const headerB64 = jose.base64url.encode(
      new TextEncoder().encode(JSON.stringify({ alg: "EdDSA" })),
    );
    const payloadB64 = jose.base64url.encode(
      new TextEncoder().encode(proof.nonce),
    );
    const compact = `${headerB64}.${payloadB64}.${proof.signature}`;
    await jose.compactVerify(compact, publicKey, { algorithms: ["EdDSA"] });
    return { valid: true };
  } catch {
    return { valid: false, error: "Signature verification failed" };
  }
}
