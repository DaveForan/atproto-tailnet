import * as jose from "jose";
import type { IssuerKeyPair } from "../../credentials/issuer.js";
import { verifyCredential, type PublicKeyResolver } from "../../credentials/verifier.js";
import type { CredentialBundle, CredentialVerificationResult } from "../../credentials/types.js";

/** Fresh Ed25519 issuer key pair for a DID. */
export async function generateIssuerKeyPair(did: string): Promise<IssuerKeyPair> {
  const { privateKey, publicKey } = await jose.generateKeyPair("EdDSA", { crv: "Ed25519" });
  return { privateKey, publicKey, did };
}

/** Verifies every credential of a bundle and checks that each subject is the holder. */
export async function verifyBundle(
  bundle: CredentialBundle,
  resolver: PublicKeyResolver,
): Promise<{ valid: boolean; results: CredentialVerificationResult[]; errors: string[] }> {
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
  return { valid: errors.length === 0, results, errors };
}
