/**
 * @module credentials/verifier
 * Verify VC-JWT credentials and holder binding proofs (ADR-0012).
 */

import * as jose from "jose";
import type {
  CredentialType,
  CredentialVerificationResult,
  HolderBindingChallenge,
  HolderBindingProof,
  CredentialBundle,
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

export async function verifyBundle(
  bundle: CredentialBundle,
  resolver: PublicKeyResolver,
): Promise<{
  valid: boolean;
  results: CredentialVerificationResult[];
  errors: string[];
}> {
  const results: CredentialVerificationResult[] = [];
  const errors: string[] = [];

  for (const cred of bundle.credentials) {
    const result = await verifyCredential(cred.jwt, resolver);
    results.push(result);

    if (!result.valid) {
      errors.push(`${cred.type}: ${result.error}`);
      continue;
    }

    if (result.subject !== bundle.holder) {
      errors.push(`${cred.type}: subject ${result.subject} does not match bundle holder ${bundle.holder}`);
      result.valid = false;
    }
  }

  return {
    valid: errors.length === 0,
    results,
    errors,
  };
}

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
    await jose.compactVerify(compact, publicKey);
    return { valid: true };
  } catch {
    return { valid: false, error: "Signature verification failed" };
  }
}

export async function verifyCredentialStatus(
  statusEndpoint: string,
  credentialId: string,
): Promise<{ valid: boolean; checked: string }> {
  try {
    const url = `${statusEndpoint}/${credentialId}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return { valid: false, checked: new Date().toISOString() };
    }
    const data = (await res.json()) as { status: string; checked: string };
    return {
      valid: data.status === "valid",
      checked: data.checked,
    };
  } catch {
    return { valid: false, checked: new Date().toISOString() };
  }
}
